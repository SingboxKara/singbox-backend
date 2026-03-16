// backend/server.js

import app from "./app.js";
import {
  PORT,
  ENABLE_REVIEW_REQUEST_SCHEDULER,
  REVIEW_REQUEST_SCHEDULER_INTERVAL_MS,
  REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS,
  REVIEW_REQUEST_BATCH_LIMIT,
} from "./config/env.js";
import { processCompletedReviewRequests } from "./services/reviewService.js";

let reviewSchedulerStarted = false;

function startReviewRequestScheduler() {
  if (reviewSchedulerStarted) return;
  reviewSchedulerStarted = true;

  if (!ENABLE_REVIEW_REQUEST_SCHEDULER) {
    console.log("⏸️ Scheduler avis désactivé via ENABLE_REVIEW_REQUEST_SCHEDULER=false");
    return;
  }

  console.log(
    `🕒 Scheduler avis activé : interval=${REVIEW_REQUEST_SCHEDULER_INTERVAL_MS}ms, initialDelay=${REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS}ms, batchLimit=${REVIEW_REQUEST_BATCH_LIMIT}`
  );

  const run = async () => {
    try {
      await processCompletedReviewRequests({
        limit: REVIEW_REQUEST_BATCH_LIMIT,
        source: "scheduler",
      });
    } catch (e) {
      console.error("❌ Erreur scheduler review requests :", e);
    }
  };

  setTimeout(() => {
    run();
    setInterval(run, REVIEW_REQUEST_SCHEDULER_INTERVAL_MS);
  }, REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS);
}

app.listen(PORT, () => {
  console.log("✅ API Stripe/Supabase en écoute sur le port", PORT);
  startReviewRequestScheduler();
});