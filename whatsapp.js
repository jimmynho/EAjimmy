// Envoi de messages WhatsApp automatiques (API WhatsApp Business « Cloud API » de Meta).
//
// Sert à envoyer le mot de passe provisoire (« Mot de passe oublié ») sur WhatsApp.
// Tant que les variables ci-dessous ne sont pas sur Railway ET Render, l'option WhatsApp reste cachée.
//
//   WHATSAPP_TOKEN            jeton d'accès permanent (Meta → Business Settings → Utilisateurs système). SECRET.
//   WHATSAPP_PHONE_NUMBER_ID  identifiant du numéro WhatsApp Business (Meta → WhatsApp → Configuration de l'API).
//   WHATSAPP_TEMPLATE         nom du modèle de message « Authentification » approuvé par Meta (par défaut : eaji_code).
//   WHATSAPP_TEMPLATE_LANG    langue du modèle (par défaut : fr).
//
// Meta impose un modèle « Authentification » : il contient un code (ici le mot de passe provisoire, 15 caractères au plus)
// et un bouton « Copier le code ».
const API = () => process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0';

function enabled() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// to : numéro au format international (+243…). code : 15 caractères au plus.
async function sendCode(to, code) {
  if (!enabled()) throw new Error('WhatsApp non configuré');
  const num = String(to || '').replace(/[^\d]/g, '');
  if (num.length < 8) throw new Error('numéro invalide');
  const c = String(code).slice(0, 15);
  const r = await fetch(`${API()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: num, type: 'template',
      template: {
        name: process.env.WHATSAPP_TEMPLATE || 'eaji_code',
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'fr' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: c }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: c }] },
        ],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`WhatsApp a refusé l'envoi (${r.status}) ${t.slice(0, 200)}`);
  }
  return true;
}

module.exports = { enabled, sendCode };
