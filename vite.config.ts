import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS in dev: phones only grant camera and microphone to secure origins.
// NO_SSL=1 serves plain HTTP, fine for localhost (already a secure context).
export default defineConfig({
  // GitHub Pages serves from /<repo>/; BASE is set by the deploy workflow.
  base: process.env.BASE ?? "/",
  plugins: process.env.NO_SSL ? [] : [basicSsl()],
  worker: { format: "es" },
  build: { target: "es2022" },
});
