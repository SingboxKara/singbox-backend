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

const FALLBACK_FRONTEND_BASE_URL = "https://site-reservation-qr.vercel.app";
const POST_SESSION_PROMO_CODE_PREFIX = "SINGBACK";
const POST_SESSION_PROMO_INITIAL_PERCENT = 30;
const POST_SESSION_PROMO_VALIDITY_DAYS = 15;
const POST_SESSION_PROMO_STAGE_1_DAYS = 2;
const POST_SESSION_PROMO_STAGE_2_DAYS = 7;
const POST_SESSION_PROMO_STAGE_3_DAYS = 15;

export function generateReviewToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getFrontendBaseUrl() {
  return String(FRONTEND_BASE_URL || FALLBACK_FRONTEND_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
}

export function buildReviewLink(token) {
  return `${getFrontendBaseUrl()}/avis.html?token=${encodeURIComponent(token)}`;
}

function buildBookingLink() {
  const base = getFrontendBaseUrl();
  return base || FALLBACK_FRONTEND_BASE_URL;
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

function addDaysToDateOnly(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateFr(dateLike) {
  const date = parseDateOrNull(dateLike);
  if (!date) return "N/A";

  return date.toLocaleDateString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function isPromoStillUsable(promo) {
  if (!promo) return false;
  if (promo.is_active === false) return false;

  const today = todayDateOnly();

  if (promo.valid_from && today < promo.valid_from) return false;
  if (promo.valid_to && today > promo.valid_to) return false;

  if (
    promo.max_uses != null &&
    Number(promo.used_count || 0) >= Number(promo.max_uses || 0)
  ) {
    return false;
  }

  return true;
}

function buildPromoNoteForReservation(reservationId) {
  return `post_session_review_discount:${String(reservationId || "").trim()}`;
}

function generatePromoCodeCandidate() {
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${POST_SESSION_PROMO_CODE_PREFIX}-${random}`;
}

async function getPromoCodeByCode(code) {
  const { data, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getExistingPostSessionPromoForReservation(reservationId) {
  const note = buildPromoNoteForReservation(reservationId);

  const { data, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("note", note)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function createUniquePostSessionPromoForReservation(reservation) {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }

  const reservationId = String(reservation?.id || "").trim();
  if (!reservationId) {
    throw new Error("reservation.id manquant pour la création du code promo");
  }

  const existing = await getExistingPostSessionPromoForReservation(reservationId);
  if (existing && isPromoStillUsable(existing)) {
    return existing;
  }

  const validFrom = todayDateOnly();
  const validTo = addDaysToDateOnly(POST_SESSION_PROMO_VALIDITY_DAYS);
  const note = buildPromoNoteForReservation(reservationId);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generatePromoCodeCandidate();
    const collision = await getPromoCodeByCode(code);

    if (collision) {
      continue;
    }

    const payload = {
      code,
      type: "percent",
      is_active: true,
      used_count: 0,
      max_uses: 1,
      value: POST_SESSION_PROMO_INITIAL_PERCENT,
      valid_from: validFrom,
      valid_to: validTo,
      first_session_only: false,
      max_uses_per_user: null,
      email_domain: null,
      note,
    };

    const { data, error } = await supabase
      .from("promo_codes")
      .insert(payload)
      .select()
      .single();

    if (!error && data) {
      return data;
    }

    if (error) {
      console.error("Erreur création code promo post-session :", error);
    }
  }

  throw new Error("Impossible de générer un code promo unique");
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

function isMissingColumnError(error, columnName) {
  const message = String(error?.message || "");
  const details = String(error?.details || "");
  const hint = String(error?.hint || "");
  const combined = `${message} ${details} ${hint}`.toLowerCase();

  return (
    combined.includes("column") &&
    combined.includes(String(columnName).toLowerCase())
  );
}

function formatSupabaseError(error) {
  if (!error) return "Erreur Supabase inconnue";

  const code = error.code ? `[${error.code}] ` : "";
  const message = error.message || "Erreur Supabase";
  const details = error.details ? ` | details: ${error.details}` : "";
  const hint = error.hint ? ` | hint: ${error.hint}` : "";

  return `${code}${message}${details}${hint}`;
}

async function insertReviewPayload(payload) {
  const { data, error } = await supabase
    .from("reviews")
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
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

  const basePayload = {
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

  let insertedReview = null;

  try {
    insertedReview = await insertReviewPayload(basePayload);
  } catch (error) {
    if (isMissingColumnError(error, "consent_publication")) {
      const fallbackPayload = {
        reservation_id: request.reservation_id,
        email: safeText(email || request.email, 160),
        name: safeText(firstName || request.name, 80),
        rating: Number(rating),
        comment: safeText(comment, 4000),
        approved: false,
        created_at: nowIso,
        updated_at: nowIso,
      };

      try {
        insertedReview = await insertReviewPayload(fallbackPayload);
      } catch (fallbackError) {
        console.error(
          "❌ Erreur insert avis (fallback sans consent_publication) :",
          fallbackError
        );
        throw new Error(formatSupabaseError(fallbackError));
      }
    } else {
      console.error("❌ Erreur insert avis :", error);
      throw new Error(formatSupabaseError(error));
    }
  }

  await markReviewRequestUsed(token);

  return {
    alreadyExists: false,
    review: insertedReview,
  };
}

export async function sendReviewRequestEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn("📧 Envoi mail avis désactivé (RESEND_API_KEY manquante).");
    return { sent: false, reason: "mail_disabled" };
  }

  if (!reservation?.email) {
    console.warn(
      "📧 Impossible d'envoyer le mail d'avis : email manquant",
      reservation?.id
    );
    return { sent: false, reason: "missing_email" };
  }

  const upsertResult = await upsertReviewRequestForReservation(reservation);

  if (upsertResult.alreadyUsed) {
    return {
      sent: false,
      reason: "already_used",
      reviewRequest: upsertResult.request,
    };
  }

  if (upsertResult.alreadySent) {
    return {
      sent: false,
      reason: "already_sent",
      reviewRequest: upsertResult.request,
    };
  }

  const reviewRequest = upsertResult.request;
  const reviewLink = buildReviewLink(reviewRequest.token);
  const bookingLink = buildBookingLink();

  let promo = null;

  try {
    promo = await createUniquePostSessionPromoForReservation(reservation);
  } catch (promoErr) {
    console.error(
      "❌ Erreur création code promo post-session pour réservation",
      reservation?.id,
      promoErr
    );
  }

  try {
    const start = reservation.start_time ? new Date(reservation.start_time) : null;

    const fmtDateTime = (d) =>
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

    const startStr = fmtDateTime(start);
    const firstNameSafe = safeText(reviewRequest.name || "bonjour", 80) || "bonjour";
    const promoExpiryLabel = promo?.valid_to ? formatDateFr(promo.valid_to) : null;

    const subject = `Merci pour votre session Singbox 🎤`;

    const promoBlock = promo
      ? `
        <div style="margin-top:18px;padding:18px;border-radius:16px;background:linear-gradient(135deg,rgba(249,115,22,0.18),rgba(234,88,12,0.08));border:1px solid rgba(251,146,60,0.38);">
          <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#FDBA74;">
            VOTRE AVANTAGE RETOUR
          </div>

          <div style="margin-top:10px;font-size:13px;color:#E5E7EB;line-height:1.7;">
            Pour vous remercier de votre venue, voici votre <strong>code promo personnel</strong> valable sur une prochaine réservation :
          </div>

          <div style="margin-top:14px;text-align:center;">
            <div style="display:inline-block;padding:14px 18px;border-radius:14px;background:#0F172A;border:1px dashed rgba(251,146,60,0.75);font-size:22px;font-weight:900;letter-spacing:0.08em;color:#F9FAFB;">
              ${promo.code}
            </div>
          </div>

          <div style="margin-top:14px;font-size:13px;color:#E5E7EB;line-height:1.75;">
            <strong>Plus vous réservez tôt, plus votre réduction est avantageuse :</strong>
          </div>

          <ul style="margin:12px 0 0 18px;padding:0;color:#E5E7EB;font-size:12.5px;line-height:1.8;">
            <li><strong>-30%</strong> pendant les <strong>2 premiers jours</strong></li>
            <li><strong>-20%</strong> jusqu’au <strong>7e jour</strong></li>
            <li><strong>-10%</strong> jusqu’au <strong>${promoExpiryLabel}</strong></li>
            <li><strong>Utilisable une seule fois</strong></li>
          </ul>

          <div style="margin-top:12px;font-size:12px;color:#CBD5E1;line-height:1.7;">
            Le même code reste actif pendant toute la période, mais sa réduction diminue automatiquement avec le temps.
          </div>

          <div style="margin-top:14px;text-align:center;">
            <a
              href="${bookingLink}"
              style="display:inline-block;padding:12px 22px;border-radius:999px;background:linear-gradient(90deg,#c94c35,#f97316);color:#F9FAFB;font-weight:800;font-size:14px;text-decoration:none;"
            >
              Réserver une nouvelle session
            </a>
          </div>
        </div>
      `
      : "";

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
              Bonjour ${firstNameSafe}, merci d’être venu chez <strong>Singbox</strong>.
              Votre session du <strong>${startStr}</strong> en <strong>Box ${reservation.box_id}</strong> est maintenant terminée, et votre retour nous aiderait beaucoup à améliorer l’expérience.
            </div>

            <div style="margin-top:18px;padding:16px;border-radius:16px;background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.30);">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                LAISSER UN AVIS
              </div>

              <div style="margin-top:10px;font-size:13px;color:#E5E7EB;line-height:1.7;">
                Cliquez sur le bouton ci-dessous pour partager votre avis.
                Ce lien est personnel et valable jusqu’au <strong>${new Date(
                  reviewRequest.expires_at
                ).toLocaleDateString("fr-FR")}</strong>.
              </div>

              <div style="margin-top:18px;text-align:center;">
                <a
                  href="${reviewLink}"
                  style="display:inline-block;padding:12px 22px;border-radius:999px;background:#F9FAFB;color:#020617;font-weight:800;font-size:14px;text-decoration:none;"
                >
                  Laisser mon avis
                </a>
              </div>
            </div>

            ${promoBlock}

            <div style="margin-top:18px;padding:16px;border-radius:16px;background:rgba(15,23,42,0.62);border:1px solid rgba(148,163,184,0.26);text-align:center;">
              <div style="font-size:13px;font-weight:800;color:#F9FAFB;">
                Envie de revenir chanter avec votre groupe ?
              </div>
              <div style="margin-top:7px;font-size:12px;color:#CBD5E1;line-height:1.6;">
                Retrouvez vos prochaines disponibilités directement sur le site Singbox.
              </div>
              <div style="margin-top:14px;">
                <a
                  href="${bookingLink}"
                  style="display:inline-block;padding:12px 20px;border-radius:999px;background:transparent;color:#F9FAFB;text-decoration:none;font-weight:800;font-size:13px;border:1px solid rgba(148,163,184,0.45);"
                >
                  Voir les disponibilités
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

    console.log(
      "✅ Email de demande d'avis envoyé à",
      reservation.email,
      "reservation",
      reservation.id
    );

    return {
      sent: true,
      reviewRequest,
      reviewLink,
      promoCode: promo?.code || null,
    };
  } catch (err) {
    console.error("❌ Erreur envoi email demande d'avis :", err);
    return {
      sent: false,
      reason: "mail_error",
      error: err.message,
      reviewRequest,
      promoCode: promo?.code || null,
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
  (row) =>
    (isReservationStatusConfirmed(row.status) || row.status === "completed") &&
    isReservationFinished(row)
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
        promoCode: sendResult.promoCode || null,
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