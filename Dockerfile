# Servidor da Kobly (API + motor dos fluxos) para o Railway.
# O contexto do build é a RAIZ do repositório: as migrações do banco ficam em supabase/migrations, fora de server/.
# Fica na raiz do repositório de propósito: o Railway usa sozinho um Dockerfile na raiz (sem configurar nada).
# O site vai para a Vercel, que ignora este arquivo.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY supabase/migrations /app/supabase/migrations
EXPOSE 8080
CMD ["node", "src/index.js"]
