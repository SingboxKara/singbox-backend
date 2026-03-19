// backend/services/emailService.js

import QRCode from "qrcode";

import { resend, mailEnabled } from "../config/mail.js";
import { BACKEND_BASE_URL, RESEND_FROM_EMAIL } from "../config/env.js";
import {
  DEPOSIT_AMOUNT_EUR,
  MODIFICATION_DEADLINE_HOURS,
  REFUND_DEADLINE_HOURS,
} from "../constants/booking.js";

function getFrontendBaseUrl() {
  const raw =
    process.env.FRONTEND_BASE_URL ||
    process.env.PUBLIC_FRONTEND_URL ||
    "https://www.singbox.fr";

  return String(raw).replace(/\/+$/, "");
}

function getManageReservationUrl(reservation) {
  const frontBase = getFrontendBaseUrl();
  const token = String(reservation?.guest_manage_token || "").trim();

  if (token) {
    return `${frontBase}/modifier-reservation.html?token=${encodeURIComponent(token)}`;
  }

  return `${frontBase}/mon-compte.html`;
}

function formatReservationDateTime(value) {
  const d = value ? new Date(value) : null;

  return d
    ? d.toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "N/A";
}

async function buildReservationQrDataUrl(reservation) {
  const qrText = `${BACKEND_BASE_URL}/api/check?id=${encodeURIComponent(
    reservation.id
  )}`;

  return QRCode.toDataURL(qrText);
}

function buildMailButtonStyles() {
  return {
    primary:
      "display:inline-block;padding:13px 22px;border-radius:999px;background:#f97316;color:#ffffff;text-decoration:none;font-weight:800;font-size:13px;letter-spacing:0.03em;",
    secondary:
      "display:inline-block;padding:12px 20px;border-radius:999px;background:transparent;color:#F9FAFB;text-decoration:none;font-weight:800;font-size:13px;border:1px solid rgba(148,163,184,0.45);",
  };
}

function buildCommonMailLayout({
  badgeText,
  title,
  intro,
  reservation,
  startStr,
  endStr,
  extraTopBlock = "",
  qrNoticeText,
  manageBlockTitle = "GÉRER VOTRE RÉSERVATION",
  manageBlockIntro = "Vous pouvez consulter votre réservation via un <strong>lien sécurisé</strong>, puis :",
}) {
  const manageReservationUrl = getManageReservationUrl(reservation);
  const { primary, secondary } = buildMailButtonStyles();

  return `
    <div style="margin:0;padding:22px 0;background:#050814;">
      <div style="max-width:720px;margin:0 auto;background:#020617;border-radius:18px;border:1px solid rgba(148,163,184,0.35);box-shadow:0 18px 45px rgba(0,0,0,0.85);overflow:hidden;">
        <div style="padding:18px 22px 20px 22px;background:radial-gradient(circle at 0% 0%,rgba(56,189,248,0.14),transparent 55%),radial-gradient(circle at 100% 0%,rgba(201,76,53,0.22),transparent 55%),#020617;color:#F9FAFB;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
            <tr>
              <td style="vertical-align:top;">
                <div style="font-weight:800;letter-spacing:0.22em;text-transform:uppercase;font-size:14px;line-height:1;">SINGBOX</div>
                <div style="margin-top:6px;font-size:12px;color:#9CA3AF;">Karaoké box privatives · Toulouse</div>
              </td>
              <td align="right" style="vertical-align:top;">
                <span style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(15,23,42,0.85);border:1px solid rgba(148,163,184,0.45);font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#E5E7EB;">
                  ${badgeText}
                </span>
              </td>
            </tr>
          </table>

          <div style="margin-top:16px;">
            <div style="font-size:22px;font-weight:900;letter-spacing:0.06em;text-transform:uppercase;">
              ${title}
            </div>
            <div style="margin-top:8px;font-size:13px;color:rgba(249,250,251,0.88);line-height:1.55;">
              ${intro}
            </div>
          </div>

          ${extraTopBlock}

          <div style="margin-top:16px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(15,23,42,0.75);border:1px solid rgba(148,163,184,0.38);">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
              <tr>
                <td style="font-size:12px;color:#9CA3AF;padding-bottom:8px;">Box réservée</td>
                <td align="right" style="font-size:12px;color:#9CA3AF;padding-bottom:8px;">Horaires</td>
              </tr>
              <tr>
                <td style="font-size:14px;font-weight:800;">Box ${reservation.box_id}</td>
                <td align="right" style="font-size:13px;font-weight:700;color:#E5E7EB;">${startStr} – ${endStr}</td>
              </tr>
            </table>
            <div style="margin-top:10px;font-size:12px;color:#E5E7EB;">
              <span style="font-weight:800;">Merci d’arriver 10 minutes en avance</span> afin de pouvoir vous installer et démarrer la session à l’heure.
            </div>
          </div>

          <div style="margin-top:12px;padding:12px 14px;border-radius:14px;background:rgba(15,23,42,0.55);border:1px solid rgba(148,163,184,0.30);">
            <div style="font-size:12.5px;color:#E5E7EB;font-weight:700;">
              ${qrNoticeText}
            </div>
            <div style="margin-top:6px;font-size:11.5px;color:#9CA3AF;">
              Présentez-le à l’accueil pour accéder à votre box.
            </div>
          </div>

          <div style="margin-top:14px;padding:16px 16px 14px 16px;border-radius:16px;background:linear-gradient(135deg,rgba(249,115,22,0.18),rgba(234,88,12,0.08));border:1px solid rgba(251,146,60,0.38);">
            <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#FDBA74;">
              ${manageBlockTitle}
            </div>
            <div style="margin-top:10px;font-size:12.5px;color:#E5E7EB;line-height:1.65;">
              ${manageBlockIntro}
            </div>

            <ul style="margin:12px 0 0 18px;padding:0;color:#E5E7EB;font-size:12.5px;line-height:1.7;">
              <li><strong>Ajouter des participants</strong> avant la séance si votre groupe s’agrandit.</li>
              <li><strong>Modifier la date ou l’horaire</strong> jusqu’à <strong>${MODIFICATION_DEADLINE_HOURS}h avant</strong>, selon disponibilités.</li>
              <li><strong>Demander un remboursement</strong> jusqu’à <strong>${REFUND_DEADLINE_HOURS}h avant</strong>.</li>
            </ul>

            <div style="margin-top:10px;font-size:11.5px;color:#FED7AA;line-height:1.6;">
              Conservez cet e-mail : le bouton ci-dessous contient votre accès sécurisé de gestion.
            </div>

            <div style="margin-top:16px;text-align:center;">
              <a href="${manageReservationUrl}" target="_blank" rel="noopener noreferrer" style="${primary}">
                Gérer ma réservation
              </a>
            </div>
            <div style="margin-top:8px;text-align:center;font-size:11px;color:#9CA3AF;">
              Ce lien est personnel et associé à cette réservation.
            </div>
          </div>

          <div style="margin-top:12px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(8,12,22,0.65);border:1px solid rgba(248,113,113,0.45);">
            <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#FCA5A5;">
              EMPREINTE BANCAIRE DE ${DEPOSIT_AMOUNT_EUR} €
            </div>
            <div style="margin-top:8px;font-size:12px;color:#E5E7EB;line-height:1.55;">
              Pour garantir le bon déroulement de la session, une empreinte bancaire de ${DEPOSIT_AMOUNT_EUR} € peut être réalisée sur votre carte bancaire.
            </div>

            <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.55;">
              <li>Il ne s’agit pas d’un débit immédiat, mais d’un blocage temporaire du montant.</li>
              <li>L’empreinte pourra être utilisée uniquement en cas de dégradations, non-respect du règlement ou frais dus.</li>
            </ul>
          </div>

          <div style="margin-top:14px;">
            <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
              INFOS PRATIQUES
            </div>
            <div style="margin-top:10px;font-size:12px;color:#E5E7EB;line-height:1.6;">
              <div><strong>Adresse :</strong> 66 Rue de la République, 31300 Toulouse</div>
              <div style="margin-top:6px;color:#9CA3AF;font-size:11.5px;">Pensez à vérifier l’accès et le stationnement avant votre venue.</div>
            </div>
          </div>

          <div style="margin-top:18px;padding:16px 14px;border-radius:14px;background:rgba(15,23,42,0.62);border:1px solid rgba(148,163,184,0.26);text-align:center;">
            <div style="font-size:13px;font-weight:800;color:#F9FAFB;">
              Besoin d’un accès classique à votre espace client ?
            </div>
            <div style="margin-top:7px;font-size:12px;color:#CBD5E1;line-height:1.6;">
              Vous pouvez aussi retrouver Singbox depuis le site principal.
            </div>
            <div style="margin-top:14px;">
              <a href="${getFrontendBaseUrl()}/mon-compte.html" target="_blank" rel="noopener noreferrer" style="${secondary}">
                Accéder à mon compte Singbox
              </a>
            </div>
          </div>

          <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(148,163,184,0.22);text-align:center;">
            <div style="font-size:11px;color:#9CA3AF;">Suivez-nous sur Instagram et TikTok : <strong style="color:#E5E7EB;">@singboxtoulouse</strong></div>
            <div style="margin-top:6px;font-size:11px;color:#9CA3AF;">Conservez cet e-mail, il vous sera demandé à l’arrivée.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function sendReservationEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn(
      "📧 Envoi mail désactivé (RESEND_API_KEY manquante) – email non envoyé."
    );
    return;
  }

  const toEmail = reservation.email;
  if (!toEmail) {
    console.warn(
      "📧 Impossible d'envoyer l'email : pas d'adresse sur la réservation",
      reservation.id
    );
    return;
  }

  try {
    const qrDataUrl = await buildReservationQrDataUrl(reservation);
    const base64Qr = qrDataUrl.split(",")[1];

    const startStr = formatReservationDateTime(reservation.start_time);
    const endStr = formatReservationDateTime(reservation.end_time);

    const subject = `Confirmation de votre réservation Singbox - Box ${reservation.box_id}`;

    const htmlBody = buildCommonMailLayout({
      badgeText: "CONFIRMATION DE RÉSERVATION",
      title: `VOTRE SESSION EST CONFIRMÉE <span style="color:#22c55e;">✅</span>`,
      intro:
        "Merci pour votre réservation chez <strong>Singbox</strong> ! Votre box karaoké privative vous attend — voici le récapitulatif de votre séance.",
      reservation,
      startStr,
      endStr,
      qrNoticeText:
        'Votre QR code est en pièce jointe (fichier <span style="font-weight:900;">qr-reservation.png</span>).',
    });

    const attachments = [
      {
        filename: "qr-reservation.png",
        content: base64Qr,
        contentType: "image/png",
      },
    ];

    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
      attachments,
    });

    console.log("✅ Email envoyé via Resend à", toEmail, "reservation", reservation.id);
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi de l'email via Resend :", err);
  }
}

export async function sendReservationModificationEmail(
  reservation,
  options = {}
) {
  if (!mailEnabled || !resend) {
    console.warn(
      "📧 Envoi mail désactivé (RESEND_API_KEY manquante) – email non envoyé."
    );
    return;
  }

  const toEmail = reservation?.email;
  if (!toEmail) {
    console.warn(
      "📧 Impossible d'envoyer l'email de modification : pas d'adresse sur la réservation",
      reservation?.id
    );
    return;
  }

  try {
    const qrDataUrl = await buildReservationQrDataUrl(reservation);
    const base64Qr = qrDataUrl.split(",")[1];

    const startStr = formatReservationDateTime(reservation.start_time);
    const endStr = formatReservationDateTime(reservation.end_time);

    const previousStartStr = formatReservationDateTime(options.previousStartTime);
    const previousEndStr = formatReservationDateTime(options.previousEndTime);

    const scheduleChanged =
      Boolean(options.scheduleChanged);

    const extraTopBlock = scheduleChanged
      ? `
        <div style="margin-top:16px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(15,23,42,0.72);border:1px solid rgba(96,165,250,0.35);">
          <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93C5FD;">
            MODIFICATION PRISE EN COMPTE
          </div>
          <div style="margin-top:10px;font-size:12.5px;color:#E5E7EB;line-height:1.65;">
            Votre réservation a bien été mise à jour.
          </div>
          <div style="margin-top:10px;font-size:12px;color:#CBD5E1;line-height:1.7;">
            <div><strong>Ancien créneau :</strong> ${previousStartStr} – ${previousEndStr}</div>
            <div style="margin-top:4px;"><strong>Nouveau créneau :</strong> ${startStr} – ${endStr}</div>
          </div>
        </div>
      `
      : `
        <div style="margin-top:16px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(15,23,42,0.72);border:1px solid rgba(96,165,250,0.35);">
          <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93C5FD;">
            MODIFICATION PRISE EN COMPTE
          </div>
          <div style="margin-top:10px;font-size:12.5px;color:#E5E7EB;line-height:1.65;">
            Votre réservation a bien été mise à jour. Retrouvez ci-dessous les informations actuelles de votre séance.
          </div>
        </div>
      `;

    const subject = `Modification confirmée de votre réservation Singbox - Box ${reservation.box_id}`;

    const htmlBody = buildCommonMailLayout({
      badgeText: "MODIFICATION CONFIRMÉE",
      title: `VOTRE RÉSERVATION A ÉTÉ MODIFIÉE <span style="color:#38bdf8;">✦</span>`,
      intro:
        "Votre demande de modification a bien été prise en compte. Vous trouverez ci-dessous le récapitulatif mis à jour de votre séance Singbox.",
      reservation,
      startStr,
      endStr,
      extraTopBlock,
      qrNoticeText: scheduleChanged
        ? 'Votre QR code de réservation est à nouveau joint à cet e-mail (fichier <span style="font-weight:900;">qr-reservation-modifiee.png</span>).'
        : 'Votre QR code de réservation est joint à cet e-mail (fichier <span style="font-weight:900;">qr-reservation-modifiee.png</span>).',
      manageBlockTitle: "BESOIN DE RE-MODIFIER VOTRE RÉSERVATION ?",
      manageBlockIntro:
        "Vous pouvez utiliser le même <strong>lien sécurisé</strong> pour consulter de nouveau votre réservation, modifier la date ou l’horaire selon disponibilités, ou demander un remboursement dans les délais prévus.",
    });

    const attachments = [
      {
        filename: "qr-reservation-modifiee.png",
        content: base64Qr,
        contentType: "image/png",
      },
    ];

    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
      attachments,
    });

    console.log(
      "✅ Email de modification envoyé via Resend à",
      toEmail,
      "reservation",
      reservation.id
    );
  } catch (err) {
    console.error(
      "❌ Erreur lors de l'envoi de l'email de modification via Resend :",
      err
    );
  }
}