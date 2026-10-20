# Node serves the dashboard; Python + numpy convert uploaded IFC files.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-numpy python3-openpyxl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY tools ./tools

ENV NODE_ENV=production PYTHON=python3
EXPOSE 3000
CMD ["node", "server.js"]
