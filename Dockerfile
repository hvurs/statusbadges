FROM denoland/deno:1.46.3
WORKDIR /app
COPY . .
RUN deno cache app.ts
CMD ["run", "-A", "app.ts"]
