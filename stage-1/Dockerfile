# No third-party dependencies: the service uses only the Node standard library,
# so nothing is fetched at run time.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
