// backend/config/mail.js

import { Resend } from "resend";
import { RESEND_API_KEY } from "./env.js";

export const mailEnabled = !!RESEND_API_KEY;
export const resend = mailEnabled ? new Resend(RESEND_API_KEY) : null;