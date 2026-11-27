# La sonda gira nella stessa versione di Node e dello stesso binding di core-api.
FROM node:24.18.0-bookworm-slim
WORKDIR /lab
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY probe.mjs ./
ENTRYPOINT ["node", "probe.mjs"]
