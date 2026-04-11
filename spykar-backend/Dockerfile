FROM node:20-alpine

RUN addgroup -g 1001 -S nodejs && adduser -S spykar -u 1001

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev && npm cache clean --force

COPY --chown=spykar:nodejs . .

RUN mkdir -p logs && chown spykar:nodejs logs

USER spykar

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "src/server.js"]