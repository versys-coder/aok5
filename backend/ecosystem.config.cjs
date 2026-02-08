module.exports = {
  apps: [
    {
      name: "aok-backend",
      cwd: "/opt/aok/backend",
      script: "index.mjs",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: "3003",

        // upstream 1C HS:
        API_BASE_URL: "https://w14.crmhit.ru/aok_gh5532r6vv4_api", // или http://...
        API_USERNAME: "profit",
        API_PASSWORD: "Potofvo15!",
        API_KEY: "ea2c6d5c-662f-472f-bf62-2811acebb2f8",

        // если upstream https с самоподписанным сертификатом:
        // ALLOW_INSECURE_TLS: "true",

        // опционально:
        // DEFAULT_CLUB_ID: "..."
      },
    },
  ],
};