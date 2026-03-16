// backend/services/emailService.js

import QRCode from "qrcode";

import { resend, mailEnabled } from "../config/mail.js";
import { BACKEND_BASE_URL, RESEND_FROM_EMAIL } from "../config/env.js";
import { DEPOSIT_AMOUNT_EUR } from "../constants/booking.js";

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
    const qrText = `${BACKEND_BASE_URL}/api/check?id=${encodeURIComponent(
      reservation.id
    )}`;

    const qrDataUrl = await QRCode.toDataURL(qrText);
    const base64Qr = qrDataUrl.split(",")[1];

    const start = reservation.start_time ? new Date(reservation.start_time) : null;
    const end = reservation.end_time ? new Date(reservation.end_time) : null;

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
    const endStr = fmt(end);

    const subject = `Confirmation de votre réservation Singbox - Box ${reservation.box_id}`;

    const htmlBody = `
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
                    CONFIRMATION DE RÉSERVATION
                  </span>
                </td>
              </tr>
            </table>

            <div style="margin-top:16px;">
              <div style="font-size:22px;font-weight:900;letter-spacing:0.06em;text-transform:uppercase;">
                VOTRE SESSION EST CONFIRMÉE <span style="color:#22c55e;">✅</span>
              </div>
              <div style="margin-top:8px;font-size:13px;color:rgba(249,250,251,0.88);line-height:1.55;">
                Merci pour votre réservation chez <strong>Singbox</strong> ! Voici le récapitulatif de votre box karaoké privative.
              </div>
            </div>

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
                Votre QR code est en pièce jointe (fichier <span style="font-weight:900;">qr-reservation.png</span>).
              </div>
              <div style="margin-top:6px;font-size:11.5px;color:#9CA3AF;">
                Présentez-le à l’accueil pour accéder à votre box.
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
                <li>L’empreinte n’est pas encaissée si la session se déroule normalement et que le règlement est respecté.</li>
                <li>En cas de dégradations ou non-respect des règles, tout ou partie de ce montant peut être prélevée après constat par l’équipe Singbox.</li>
              </ul>

              <div style="margin-top:10px;font-size:11px;color:#9CA3AF;">
                Les délais de libération de l’empreinte dépendent de votre banque (généralement quelques jours).
              </div>
            </div>

            <div style="margin-top:16px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                CONDITIONS D’ANNULATION
              </div>
              <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.6;">
                <li>Annulation gratuite jusqu’à <strong>24h</strong> avant le début de la session.</li>
                <li>Passé ce délai, la réservation est considérée comme due et non remboursable.</li>
                <li>En cas de retard important, la session pourra être écourtée sans compensation afin de respecter les créneaux suivants.</li>
              </ul>
            </div>

            <div style="margin-top:14px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                RÈGLEMENT INTÉRIEUR SINGBOX
              </div>
              <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.6;">
                <li><strong>Respect du matériel :</strong> micros, écrans, banquettes et équipements doivent être utilisés avec soin.</li>
                <li><strong>Comportement :</strong> toute attitude violente, insultante ou dangereuse peut entraîner l’arrêt immédiat de la session.</li>
                <li><strong>Alcool & drogues :</strong> l’accès pourra être refusé en cas d’état d’ivresse avancé ou de consommation de substances illicites.</li>
                <li><strong>Fumée :</strong> il est strictement interdit de fumer dans les box.</li>
                <li><strong>Nuisances sonores :</strong> merci de respecter les autres clients et le voisinage dans les espaces communs.</li>
                <li><strong>Capacité maximale :</strong> le nombre de personnes par box ne doit pas dépasser la limite indiquée sur place.</li>
              </ul>

              <div style="margin-top:10px;font-size:11px;color:#9CA3AF;">
                En validant votre réservation, vous acceptez le règlement intérieur de Singbox.
              </div>
            </div>

            <div style="margin-top:14px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                INFOS PRATIQUES
              </div>
              <div style="margin-top:10px;font-size:12px;color:#E5E7EB;line-height:1.6;">
                <div><strong>Adresse :</strong> 66 Rue de la République, 31300 Toulouse (à adapter si besoin).</div>
                <div style="margin-top:6px;color:#9CA3AF;font-size:11.5px;">Pensez à vérifier l’accès et le stationnement avant votre venue.</div>
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