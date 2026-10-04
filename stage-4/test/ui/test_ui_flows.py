"""Browser tests for the stage-2 rules that the shipped smoke checks do not exercise.

Needs Python with `pytest`, `httpx` and `playwright` (chromium installed), and running
services:

    PORT=18082 node src/server.js                       # this stage
    PORT=18081 node ../stage-1/src/server.js            # the preceding stage (upgrade test)
    TK_BASE=http://127.0.0.1:18082 TK_PREV=http://127.0.0.1:18081 pytest test/ui
"""
import datetime as dt
import json
import os
import re
import uuid

import httpx
import pytest
from playwright.sync_api import sync_playwright

BASE = os.environ.get("TK_BASE", "http://127.0.0.1:18082")
PREV = os.environ.get("TK_PREV")
ADA = {"id": "u_ada", "email": "ada@example.com", "password": "correct horse", "display_name": "Ada"}
BOB = {"id": "u_bob", "email": "bob@example.com", "password": "correct horse", "display_name": "Bob"}
WEEK = [{"weekday": d, "opens": "18:00", "closes": "23:00"} for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")]
DATE = (dt.date.today() + dt.timedelta(days=7)).isoformat()
OTHER_DATE = (dt.date.today() + dt.timedelta(days=8)).isoformat()


def restaurant(**over):
    r = {"id": "r_anker", "name": "Zum Anker", "timezone": "Europe/Berlin", "slot_minutes": 30,
         "reservation_duration_minutes": 90, "cancellation_cutoff_minutes": 120, "opening_hours": WEEK,
         "tables": [{"id": "t_1", "label": "Window", "capacity": 2}, {"id": "t_2", "label": "Garden", "capacity": 4},
                    {"id": "t_3", "label": "Hearth", "capacity": 6}],
         "combinable": [["t_1", "t_2"]]}
    r.update(over)
    return r


def reset(base=BASE, **over):
    fixture = {"users": [ADA, BOB], "restaurants": [restaurant()], "reservations": []}
    fixture.update(over)
    assert httpx.post(f"{base}/_test/reset", json=fixture, timeout=10).status_code == 204


def token(email, base=BASE):
    return httpx.post(f"{base}/auth/login", json={"email": email, "password": "correct horse"}).json()["token"]


def sel(name):
    return f"[data-testid='{name}']"


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(base_url=BASE)
    pg = ctx.new_page()
    pg.set_default_timeout(8000)
    yield pg
    ctx.close()


def log_in(page):
    page.goto("/login")
    page.fill(sel("login-email"), ADA["email"])
    page.fill(sel("login-password"), ADA["password"])
    page.click(sel("login-submit"))
    page.wait_for_selector(sel("current-user"))


def search(page, party=4, date=DATE, goto=True):
    if goto:
        page.goto("/")
    page.select_option(sel("restaurant-select"), "r_anker")
    page.fill(sel("date-input"), date)
    page.fill(sel("party-size-input"), str(party))
    page.click(sel("search-button"))
    page.wait_for_selector(f"{sel('availability-grid')}, {sel('no-slots')}")


def open_form(page, cell="slot-t_2-19:00", party=4):
    log_in(page)
    search(page, party=party)
    page.click(sel(cell))
    page.wait_for_selector(sel("booking-form"))


def confirmed_for(email):
    resp = httpx.get(f"{BASE}/reservations", headers={"Authorization": f"Bearer {token(email)}"})
    return [r for r in resp.json()["reservations"] if r["status"] == "confirmed"]


# ---- out-of-order search ---------------------------------------------------------------

def test_a_late_search_response_does_not_replace_the_newer_one(page):
    reset()
    page.goto("/")
    held = []

    def hold_first(route):
        if not held:
            held.append(route)  # leave search A pending
        else:
            route.continue_()

    page.route("**/availability?*", hold_first)
    page.select_option(sel("restaurant-select"), "r_anker")
    page.fill(sel("date-input"), DATE)
    page.fill(sel("party-size-input"), "2")
    page.click(sel("search-button"))  # A: held, so no grid yet
    for _ in range(100):
        if held:
            break
        page.wait_for_timeout(20)
    assert held, "search A should be pending"
    page.fill(sel("party-size-input"), "6")
    page.click(sel("search-button"))  # B
    page.wait_for_selector(sel("availability-grid"))
    held[0].continue_()  # A finishes after B
    page.wait_for_timeout(700)
    # B searched for 6 guests: only t_3 (and no pair) fits.
    assert page.get_attribute(sel("slot-t_1-19:00"), "data-available") == "false"
    assert page.get_attribute(sel("slot-t_3-19:00"), "data-available") == "true"
    assert page.query_selector(sel("slot-t_1+t_2-19:00")) is not None  # pair of 6 fits 6


def test_a_new_search_closes_the_old_booking_form(page):
    reset()
    open_form(page)
    search(page, party=2, date=OTHER_DATE, goto=False)
    assert page.query_selector(sel("booking-form")) is None


# ---- 409 while the form is open --------------------------------------------------------

def test_conflict_shows_error_keeps_form_and_refreshes_grid(page):
    reset()
    open_form(page)
    page.fill(sel("booking-party-size"), "3")
    httpx.post(f"{BASE}/reservations", headers={"Authorization": f"Bearer {token(BOB['email'])}",
                                                "Idempotency-Key": uuid.uuid4().hex},
               json={"restaurant_id": "r_anker", "table_id": "t_2", "starts_at_local": f"{DATE}T19:00", "party_size": 4})
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-error"))
    assert page.query_selector(sel("confirmation")) is None
    assert page.query_selector(sel("booking-uncertain")) is None
    assert page.input_value(sel("booking-party-size")) == "3"
    page.wait_for_function(
        "document.querySelector(\"[data-testid='slot-t_2-19:00']\").dataset.available === 'false'")


# ---- lost responses --------------------------------------------------------------------

def test_lost_response_after_commit_is_uncertain_then_recovers_original(page):
    reset()
    open_form(page)
    keys = []

    def lose_response(route):
        keys.append(route.request.headers.get("idempotency-key"))
        route.fetch()  # the booking commits on the server
        route.abort("connectionreset")

    page.route("**/reservations", lose_response)
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    assert page.text_content(sel("booking-uncertain")).strip()
    assert page.query_selector(sel("booking-error")) is None
    assert page.query_selector(sel("confirmation")) is None
    original = confirmed_for(ADA["email"])
    assert len(original) == 1

    page.unroute("**/reservations")
    retry_keys = []
    page.on("request", lambda r: retry_keys.append(r.headers.get("idempotency-key"))
            if r.url.endswith("/reservations") and r.method == "POST" else None)
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    assert page.text_content(sel("confirmation-reference")).strip() == original[0]["reference"]
    assert page.query_selector(sel("booking-uncertain")) is None
    assert page.query_selector(sel("booking-error")) is None
    assert retry_keys == keys, "the retry must reuse the idempotency key"
    assert len(confirmed_for(ADA["email"])) == 1


def test_lost_request_before_commit_retries_as_the_first_booking(page):
    reset()
    open_form(page)
    page.route("**/reservations", lambda route: route.abort("connectionrefused"))
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    assert confirmed_for(ADA["email"]) == []
    page.unroute("**/reservations")
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    assert len(confirmed_for(ADA["email"])) == 1


def test_uncertain_then_confirmed_rejection_shows_booking_error(page):
    reset()
    open_form(page)
    page.route("**/reservations", lambda route: route.abort("connectionreset"))
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    httpx.post(f"{BASE}/reservations", headers={"Authorization": f"Bearer {token(BOB['email'])}",
                                                "Idempotency-Key": uuid.uuid4().hex},
               json={"restaurant_id": "r_anker", "table_id": "t_2", "starts_at_local": f"{DATE}T19:00", "party_size": 4})
    page.unroute("**/reservations")
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-error"))
    assert page.query_selector(sel("booking-uncertain")) is None
    assert page.query_selector(sel("confirmation")) is None


# ---- combined tables -----------------------------------------------------------------

def test_combination_booking_end_to_end(page):
    reset()
    open_form(page, cell="slot-t_1+t_2-19:00", party=6)
    summary = page.text_content(sel("booking-summary"))
    assert "Window" in summary and "Garden" in summary and "19:00" in summary
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    tables = page.text_content(sel("confirmation-tables"))
    assert "Window" in tables and "Garden" in tables
    ref = page.text_content(sel("confirmation-reference")).strip()
    assert confirmed_for(ADA["email"])[0]["table_ids"] == ["t_1", "t_2"]
    page.wait_for_function(
        "document.querySelector(\"[data-testid='slot-t_1-19:00']\").dataset.available === 'false'")
    page.goto("/lookup")
    page.fill(sel("lookup-reference-input"), ref)
    page.click(sel("lookup-submit"))
    page.wait_for_selector(sel("reservation-detail"))
    text = page.text_content(sel("reservation-tables"))
    assert "Window" in text and "Garden" in text


def test_combination_lost_response_recovers_original(page):
    reset()
    open_form(page, cell="slot-t_1+t_2-19:00", party=6)
    page.route("**/reservations", lambda route: (route.fetch(), route.abort("connectionreset")))
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    assert page.query_selector(sel("confirmation")) is None
    page.unroute("**/reservations")
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    booked = confirmed_for(ADA["email"])
    assert len(booked) == 1 and booked[0]["table_ids"] == ["t_1", "t_2"]
    assert page.text_content(sel("confirmation-reference")).strip() == booked[0]["reference"]
    assert page.query_selector(sel("booking-uncertain")) is None


def test_combination_conflict_keeps_form_and_shows_error(page):
    reset()
    open_form(page, cell="slot-t_1+t_2-19:00", party=5)
    httpx.post(f"{BASE}/reservations", headers={"Authorization": f"Bearer {token(BOB['email'])}",
                                                "Idempotency-Key": uuid.uuid4().hex},
               json={"restaurant_id": "r_anker", "table_id": "t_1", "starts_at_local": f"{DATE}T19:30", "party_size": 2})
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-error"))
    assert page.query_selector(sel("confirmation")) is None
    assert page.input_value(sel("booking-party-size")) == "5"
    page.wait_for_function(
        "document.querySelector(\"[data-testid='slot-t_1+t_2-19:00']\").dataset.available === 'false'")


def test_combination_cells_only_for_pairs_that_fit(page):
    reset()
    search(page, party=7)
    assert page.query_selector(sel("slot-t_1+t_2-19:00")) is None  # 2 + 4 < 7
    search(page, party=2)
    assert page.get_attribute(sel("slot-t_1+t_2-19:00"), "data-available") == "true"


# ---- lookup ---------------------------------------------------------------------------

def test_refused_cancel_shows_reservation_error(page):
    reset(restaurants=[restaurant(cancellation_cutoff_minutes=60 * 24 * 3650)])
    open_form(page)
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    ref = page.text_content(sel("confirmation-reference")).strip()
    page.goto("/lookup")
    page.fill(sel("lookup-reference-input"), ref)
    page.click(sel("lookup-submit"))
    page.click(sel("reservation-cancel-button"))
    page.wait_for_selector(sel("reservation-error"))
    assert page.text_content(sel("reservation-status")).strip() == "confirmed"


# ---- upgrade ---------------------------------------------------------------------------

def test_upgrade_keeps_session_form_and_pending_retry(page):
    """Export/import between browser requests: session, lookup and the lost booking survive."""
    reset()
    open_form(page)
    page.route("**/reservations", lambda route: (route.fetch(), route.abort("connectionreset")))
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    page.unroute("**/reservations")
    snapshot = httpx.get(f"{BASE}/_test/export").json()
    reset(users=[BOB], restaurants=[restaurant(id="r_other", name="Other")])
    assert httpx.post(f"{BASE}/_test/import", json=snapshot, timeout=10).status_code == 204
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    ref = page.text_content(sel("confirmation-reference")).strip()
    assert [r["reference"] for r in confirmed_for(ADA["email"])] == [ref]
    page.click("a[href='/lookup']")
    page.wait_for_selector(sel("current-user"))
    page.fill(sel("lookup-reference-input"), ref)
    page.click(sel("lookup-submit"))
    page.wait_for_selector(sel("reservation-detail"))


@pytest.mark.skipif(not PREV, reason="set TK_PREV to the stage-1 service URL")
def test_upgrade_from_stage_1_recovers_the_original_confirmation(page):
    """The browser talks to the stage-1 API, loses a booking response, and the state is
    exported from stage 1 and imported into stage 2 before the retry."""
    reset(base=PREV, restaurants=[{k: v for k, v in restaurant().items() if k != "combinable"}])
    reset()

    def to_previous(route):
        url = route.request.url
        path = url.split(BASE, 1)[1]
        if path.startswith(("/assets/", "/?")) or path in ("/", "/login", "/signup", "/lookup"):
            route.continue_()
            return
        resp = route.fetch(url=PREV + path)
        route.fulfill(response=resp)

    page.route(f"{BASE}/**", to_previous)
    open_form(page)
    page.unroute(f"{BASE}/**")

    def lose(route):
        route.fetch(url=PREV + "/reservations")
        route.abort("connectionreset")

    page.route("**/reservations", lose)
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("booking-uncertain"))
    page.unroute("**/reservations")
    snapshot = httpx.get(f"{PREV}/_test/export").json()
    assert httpx.post(f"{BASE}/_test/import", json=snapshot, timeout=10).status_code == 204
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    ref = page.text_content(sel("confirmation-reference")).strip()
    prev_token = json.loads(page.evaluate("localStorage.getItem('tablekeeper.session')"))["token"]
    got = httpx.get(f"{BASE}/reservations/{ref}", headers={"Authorization": f"Bearer {prev_token}"})
    assert got.status_code == 200
    assert page.query_selector(sel("current-user")) is not None


# ---- responsive ------------------------------------------------------------------------

@pytest.mark.parametrize("width", [375, 1280])
def test_no_horizontal_page_scroll(browser, width):
    reset(restaurants=[restaurant(tables=[{"id": f"t_{i}", "label": f"Long table name {i}", "capacity": 4}
                                          for i in range(1, 9)],
                                  combinable=[["t_1", "t_2"], ["t_3", "t_4"]])])
    ctx = browser.new_context(base_url=BASE, viewport={"width": width, "height": 800})
    page = ctx.new_page()
    try:
        open_form(page, cell="slot-t_1-19:00", party=2)
        page.click(sel("booking-submit"))
        page.wait_for_selector(sel("confirmation"))
        for route in ("/", "/login", "/signup", "/lookup"):
            if route != "/":
                page.goto(route)
            overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            assert overflow <= 0, f"{route} scrolls horizontally by {overflow}px at {width}px"
    finally:
        ctx.close()


def test_inputs_have_visible_labels(page):
    reset()
    for route in ("/", "/login", "/signup", "/lookup"):
        page.goto(route)
        unlabeled = page.evaluate("""() => [...document.querySelectorAll('main input, main select')]
            .filter((el) => !(el.id && document.querySelector(`label[for="${el.id}"]`)))
            .map((el) => el.dataset.testid)""")
        assert unlabeled == [], f"{route}: {unlabeled}"


# ---- stage 3: policy-aware grid ---------------------------------------------------------

def test_too_small_tables_say_so_and_policy_capacities_apply(page):
    reset(restaurants=[restaurant(manager_user_ids=["u_ada"])])
    search(page, party=5)
    assert page.get_attribute(sel("slot-t_1-19:00"), "data-available") == "false"
    assert "Too small" in page.text_content(sel("slot-t_1-19:00"))
    ada = token(ADA["email"])
    resp = httpx.post(f"{BASE}/restaurants/r_anker/policies", headers={"Authorization": f"Bearer {ada}", "Idempotency-Key": uuid.uuid4().hex},
                      json={"effective_from": DATE, "slot_minutes": 30, "reservation_duration_minutes": 90,
                            "cancellation_cutoff_minutes": 120, "opening_hours": WEEK, "capacities": {"t_1": 6, "t_2": 4, "t_3": 6}})
    assert resp.status_code == 201, resp.text
    search(page, party=5)
    assert page.get_attribute(sel("slot-t_1-19:00"), "data-available") == "true"
    assert "6 seats" in page.text_content(sel("slot-t_1-19:00"))
    assert "Too small" in page.text_content(sel("slot-t_2-19:00"))


# ---- stage 4: screens reflect an applied seating plan ---------------------------------------

def test_confirmation_and_lookup_reflect_an_applied_plan(page):
    from zoneinfo import ZoneInfo
    reset(restaurants=[restaurant(manager_user_ids=["u_ada"])])
    open_form(page)  # Garden (t_2) at 19:00
    page.click(sel("booking-submit"))
    page.wait_for_selector(sel("confirmation"))
    ref = page.text_content(sel("confirmation-reference")).strip()
    day = dt.date.fromisoformat(DATE)
    at = lambda h: dt.datetime.combine(day, dt.time(h), tzinfo=ZoneInfo("Europe/Berlin")).isoformat()
    ada = {"Authorization": f"Bearer {token(ADA['email'])}"}
    plan = httpx.post(f"{BASE}/restaurants/r_anker/replans", headers={**ada, "Idempotency-Key": uuid.uuid4().hex},
                      json={"table_id": "t_2", "from": at(18), "to": at(23)}).json()
    assert plan["assignments"] == [{"reference": ref, "table_ids": ["t_3"], "changed": True}], plan
    applied = httpx.post(f"{BASE}/restaurants/r_anker/replans/{plan['plan_id']}/apply",
                         headers={**ada, "Idempotency-Key": uuid.uuid4().hex}, json={})
    assert applied.status_code == 201, applied.text
    # Re-submitting the unchanged form replays the receipt; the screen shows the current table.
    page.click(sel("booking-submit"))
    page.wait_for_function("(document.querySelector(\"[data-testid='confirmation-tables']\") || {textContent: ''}).textContent.includes('Hearth')")
    assert page.text_content(sel("confirmation-reference")).strip() == ref
    page.goto("/lookup")
    page.fill(sel("lookup-reference-input"), ref)
    page.click(sel("lookup-submit"))
    page.wait_for_selector(sel("reservation-detail"))
    assert "Hearth" in page.text_content(sel("reservation-tables"))
    search(page, party=4)
    assert page.get_attribute(sel("slot-t_2-21:00"), "data-available") == "false"
