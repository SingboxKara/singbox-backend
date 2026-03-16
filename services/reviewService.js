// backend/services/reviewService.js

import crypto from "crypto";

import { supabase } from "../config/supabase.js";
import { resend, mailEnabled } from "../config/mail.js";
import {
  FRONTEND_BASE_URL,
  RESEND_FROM_EMAIL,
  REVIEW_REQUEST_EXPIRY_DAYS,
  REVIEW_REQUEST_BATCH_LIMIT,
} from "../config/env.js";

import { safeText } from "../utils/validators.js";
import { parseDateOrNull } from "../utils/dates.js";
import { isReservationStatusConfirmed } from "./reservationService.js";

export function generateReviewToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function buildReviewLink(token) {
  return `${FRONTEND_BASE_URL}/avis.html?token=${encodeURIComponent(token)}`;
}

export function getFirstNameFromReservation(reservation) {
  const name = String(reservation?.name || "").trim();
  if (!name) return null;
  const first = name.split(/\s+/)[0];
  return safeText(first, 80);
}

export function addDaysToIsoNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function isReservationFinished(reservation) {
  const end = parseDateOrNull(reservation?.end_time);
  if (!end) return false;
  return end.getTime() < Date.now();
}

export async function getReservationById(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .single();

  if (error) throw error;
  return data;
}

export async function getExistingReviewRequestByReservationId(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("review_requests")
    .select("*")
    .eq("reservation_id", String(reservationId))
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function upsertReviewRequestForReservation(reservation) {
  if (!supabase) throw new Error("Supabase non configuré");

  const reservationId = String(reservation?.id || "").trim();
  const email = safeText(reservation?.email, 160);
  const firstName = getFirstNameFromReservation(reservation);

  if (!reservationId) {
    throw new Error("reservation.id manquant pour la demande d’avis");
  }
  if (!email) {
    throw new Error("reservation.email manquant pour la demande d’avis");
  }

  const existing = await getExistingReviewRequestByReservationId(reservationId);

  if (existing && existing.status === "used") {
    return {
      request: existing,
      alreadyUsed: true,
      created: false,
    };
  }

  if (existing && existing.sent_at && existing.status === "pending") {
    return {
      request: existing,
      alreadyUsed: false,
      created: false,
      alreadySent: true,
    };
  }

  const token = generateReviewToken();
  const nowIso = new Date().toISOString();
  const expiresAt = addDaysToIsoNow(REVIEW_REQUEST_EXPIRY_DAYS);

  const payload = {
    reservation_id: reservationId,
    email,
    name: firstName,
    token,
    status: "pending",
    sent_at: existing?.sent_at || null,
    used_at: null,
    expires_at: expiresAt,
    created_at: existing?.created_at || nowIso,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from("review_requests")
    .upsert(payload, { onConflict: "reservation_id" })
    .select()
    .single();

  if (error) throw error;

  return {
    request: data,
    alreadyUsed: false,
    created: !existing,
    alreadySent: false,
  };
}

export async function markReviewRequestSent(reviewRequestId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("review_requests")
    .update({
      sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", reviewRequestId);

  if (error) throw error;
}

export async function getReviewRequestByToken(token) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("review_requests")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function markReviewRequestUsed(token) {
  if (!supabase) throw new Error("Supabase non configuré");

  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("review_requests")
    .update({
      status: "used",
      used_at: nowIso,
      updated_at: nowIso,
    })
    .eq("token", token)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function expireReviewRequestIfNeeded(request) {
  if (!request) return null;
  if (request.status !== "pending") return request;

  const expiresAt = parseDateOrNull(request.expires_at);
  if (!expiresAt) return request;

  if (expiresAt.getTime() > Date.now()) {
    return request;
  }

  const { data, error } = await supabase
    .from("review_requests")
    .update({
      status: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getExistingReviewForReservation(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("reviews")
    .select("id, reservation_id")
    .eq("reservation_id", reservationId)
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

export async function createReviewFromToken({
  token,
  firstName,
  email,
  rating,
  comment,
  consentPublication,
}) {
  if (!supabase) throw new Error("Supabase non configuré");

  let request = await getReviewRequestByToken(token);

  if (!request) {
    throw new Error("Lien d’avis introuvable");
  }

  request = await expireReviewRequestIfNeeded(request);

  if (request.status === "used") {
    throw new Error("Ce lien d’avis a déjà été utilisé");
  }

  if (request.status === "expired") {
    throw new Error("Ce lien d’avis a expiré");
  }

  const reservation = await getReservationById(request.reservation_id);

  if (!reservation) {
    throw new Error("Réservation associée introuvable");
  }

  if (!isReservationStatusConfirmed(reservation.status)) {
    throw new Error("Réservation non valide pour un avis");
  }

  if (!isReservationFinished(reservation)) {
    throw new Error("La séance n’est pas encore terminée");
  }

  const existingReview = await getExistingReviewForReservation(request.reservation_id);
  if (existingReview) {
    await markReviewRequestUsed(token);
    return {
      alreadyExists: true,
      review: existingReview,
    };
  }

  const nowIso = new Date().toISOString();

  const payload = {
    reservation_id: request.reservation_id,
    email: safeText(email || request.email, 160),
    name: safeText(firstName || request.name, 80),
    rating: Number(rating),
    comment: safeText(comment, 4000),
    approved: false,
    created_at: nowIso,
    updated_at: nowIso,
    consent_publication: !!consentPublication,
  };

  const { data, error } = await supabase
    .from("reviews")
    .insert(payload)
    .select()
    .single();

  if (error) throw error;

  await markReviewRequestUsed(token);

  return {
    alreadyExists: false,
    review: data,
  };
}

export async function sendReviewRequestEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn("📧 Envoi mail avis désactivé (RESEND_API_KEY manquante).");
    return { sent: false, reason: "mail_disabled" };
  }

  if (!reservation?.email) {
    console.warn("📧 Impossible d'envoyer le mail d'avis : email manquant", reservation?.id);
    return { sent: false, reason: "missing_email" };
  }

  const upsertResult = await upsertReviewRequestForReservation(reservation);

  if (upsertResult.alreadyUsed) {
    return { sent: false, reason: "already_used", reviewRequest: upsertResult.request };
  }

  if (upsertResult.alreadySent) {
    return { sent: false, reason: "already_sent", reviewRequest: upsertResult.request };
  }

  const reviewRequest = upsertResult.request;
  const reviewLink = buildReviewLink(reviewRequest.token);

  try {
    const start = reservation.start_time ? new Date(reservation.start_time) : null;

    const fmt = (d) =>
      d
        ? d.toLocaleString("fr-FR", {
            timeZone: "Europe/Paris",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "N/A";

    const startStr = fmt(start);
    const firstName = safeText(reviewRequest.name || "bonjour", 80) || "bonjour";

    const subject = `Votre avis sur votre session Singbox`;

    const htmlBody = `
      <div style="margin:0;padding:22px 0;background:#050814;">
        <div style="max-width:720px;margin:0 auto;background:#020617;border-radius:18px;border:1px solid rgba(148,163,184,0.35);box-shadow:0 18px 45px rgba(0,0,0,0.85);overflow:hidden;">
          <div style="padding:22px;background:radial-gradient(circle at 0% 0%,rgba(56,189,248,0.14),transparent 55%),radial-gradient(circle at 100% 0%,rgba(201,76,53,0.22),transparent 55%),#020617;color:#F9FAFB;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            <div style="font-weight:800;letter-spacing:0.22em;text-transform:uppercase;font-size:14px;line-height:1;">SINGBOX</div>
            <div style="margin-top:6px;font-size:12px;color:#9CA3AF;">Karaoké box privatives · Toulouse</div>

            <div style="margin-top:18px;font-size:24px;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;">
              MERCI POUR VOTRE VISITE 🎤
            </div>

            <div style="margin-top:10px;font-size:14px;line-height:1.65;color:rgba(249,250,251,0.9);">
              Bonjour ${firstName}, merci d’être venu chez <strong>Singbox</strong>.
              Votre session du <strong>${startStr}</strong> en <strong>Box ${reservation.box_id}</strong> s’est terminée, et votre retour nous aiderait beaucoup.
            </div>

            <div style="margin-top:18px;padding:16px;border-radius:16px;background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.30);">
              <div style="font-size:13px;color:#E5E7EB;line-height:1.65;">
                Cliquez sur le bouton ci-dessous pour laisser votre avis.
                Ce lien est personnel et valable jusqu’au <strong>${new Date(reviewRequest.expires_at).toLocaleDateString("fr-FR")}</strong>.
              </div>

              <div style="margin-top:18px;text-align:center;">
                <a
                  href="${reviewLink}"
                  style="display:inline-block;padding:12px 22px;border-radius:999px;background:linear-gradient(90deg,#c94c35,#f97316);color:#F9FAFB;font-weight:800;font-size:14px;text-decoration:none;"
                >
                  Laisser mon avis
                </a>
              </div>
            </div>

            <div style="margin-top:16px;font-size:11px;color:#9CA3AF;line-height:1.6;">
              Si vous n’arrivez pas à cliquer sur le bouton, copiez-collez ce lien dans votre navigateur :
              <br />
              <span style="word-break:break-all;color:#E5E7EB;">${reviewLink}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: reservation.email,
      subject,
      html: htmlBody,
    });

    await markReviewRequestSent(reviewRequest.id);

    console.log("✅ Email de demande d'avis envoyé à", reservation.email, "reservation", reservation.id);

    return {
      sent: true,
      reviewRequest,
      reviewLink,
    };
  } catch (err) {
    console.error("❌ Erreur envoi email demande d'avis :", err);
    return {
      sent: false,
      reason: "mail_error",
      error: err.message,
      reviewRequest,
    };
  }
}

export async function processCompletedReviewRequests(options = {}) {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }

  const limit = Math.min(
    Math.max(Number(options.limit || REVIEW_REQUEST_BATCH_LIMIT), 1),
    100
  );

  const source = safeText(options.source, 50) || "unknown";
  const nowIso = new Date().toISOString();

  const { data: reservations, error } = await supabase
    .from("reservations")
    .select("*")
    .lt("end_time", nowIso)
    .order("end_time", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  const confirmedFinishedReservations = (reservations || []).filter(
    (row) => isReservationStatusConfirmed(row.status) && isReservationFinished(row)
  );

  const results = [];

  for (const reservation of confirmedFinishedReservations) {
    try {
      const existing = await getExistingReviewRequestByReservationId(reservation.id);

      if (existing?.status === "used") {
        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          skipped: true,
          reason: "already_used",
        });
        continue;
      }

      if (existing?.sent_at && existing?.status === "pending") {
        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          skipped: true,
          reason: "already_sent",
        });
        continue;
      }

      const sendResult = await sendReviewRequestEmail(reservation);

      results.push({
        reservationId: reservation.id,
        email: reservation.email,
        sent: !!sendResult.sent,
        reason: sendResult.reason || null,
      });
    } catch (itemErr) {
      console.error("Erreur envoi review request reservation", reservation.id, itemErr);
      results.push({
        reservationId: reservation.id,
        email: reservation.email,
        sent: false,
        reason: itemErr.message || "error",
      });
    }
  }

  const sentCount = results.filter((r) => r.sent).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const failedCount = results.filter((r) => r.sent === false && !r.skipped).length;

  console.log(
    `🕒 Review scheduler [${source}] terminé : processed=${results.length}, sent=${sentCount}, skipped=${skippedCount}, failed=${failedCount}`
  );

  return {
    success: true,
    source,
    totalProcessed: results.length,
    sentCount,
    skippedCount,
    failedCount,
    results,
  };
}