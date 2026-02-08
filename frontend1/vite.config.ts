import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // nginx: https://profit-group.online/aok5/
  base: "/aok5/",
  plugins: [react()],
});
