# Handyman Pro — portable container (Fly.io, Railway, any Docker host)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .
# SQLite lives here; mount a volume on /app/data in production.
ENV DB_PATH=/app/data/handyman.db
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
