FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

# 1. Recibir variables de compilacion desde el builder de Railway / Docker
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL

# 2. Exponerlas como variables de entorno durante el "npm run build"
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

# 3. Validacion de presencia de variables en tiempo de compilacion
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && echo "SUPABASE_URL: OK" || echo "SUPABASE_URL: MISSING"
RUN test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" && echo "SUPABASE_ANON_KEY: OK" || echo "SUPABASE_ANON_KEY: MISSING"

RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "npm start -- -p ${PORT:-3000}"]