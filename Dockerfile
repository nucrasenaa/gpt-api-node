FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/secrets/accounts /app/outputs/chatgpt-images /app/outputs/chatgpt-research
EXPOSE 8000
CMD ["node", "dist/index.js"]
