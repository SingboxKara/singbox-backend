// backend/server.js

import app from "./app.js";
import { PORT } from "./config/env.js";

app.listen(PORT, () => {
  console.log("✅ API Stripe/Supabase en écoute sur le port", PORT);
});