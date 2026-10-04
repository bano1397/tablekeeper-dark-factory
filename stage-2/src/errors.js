'use strict';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const malformed = (m) => new ApiError(400, 'malformed_request', m || 'request body is malformed');
const invalid = (m) => new ApiError(422, 'validation_failed', m || 'validation failed');
const notFound = (m) => new ApiError(404, 'not_found', m || 'not found');
const unauthenticated = (m) => new ApiError(401, 'unauthenticated', m || 'authentication required');

module.exports = { ApiError, malformed, invalid, notFound, unauthenticated };
