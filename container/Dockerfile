FROM node:20-slim

RUN apt-get update && apt-get install -y git jq curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --production

EXPOSE 3000
CMD ["node", "dist/server.js"]
