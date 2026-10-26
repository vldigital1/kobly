# Servidor da Kobly (API + motor dos fluxos) para o Railway.
# O contexto do build é a RAIZ do repositório: as migrações do banco ficam em supabase/migrations, fora de server/.
# No Railway: Root Directory vazio (raiz) e Config File /server/railway.json (aponta para este Dockerfile).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY supabase/migrations /app/supabase/migrations
EXPOSE 8080
CMD ["node", "src/index.js"]
