# Construit depuis la racine du dépôt : docker build -f server/Dockerfile .
FROM node:22-alpine
WORKDIR /app
# Aucune dépendance npm : seulement le serveur et la logique de correspondance partagée avec l'application.
COPY package.json ./
COPY src/js/match.js ./src/js/match.js
COPY src/data/postcodes.json ./src/data/postcodes.json
COPY server/*.mjs ./server/
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=10s CMD wget -qO- http://localhost:8787/health || exit 1
CMD ["node", "server/index.mjs"]
