FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && echo "SUPABASE_URL: OK" || echo "SUPABASE_URL: MISSING"
RUN test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" && echo "SUPABASE_ANON_KEY: OK" || echo "SUPABASE_ANON_KEY: MISSING"

RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "npm start -- -p ${PORT:-3000}"]