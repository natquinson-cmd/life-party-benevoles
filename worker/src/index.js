// Inscriptions des benevoles Life Party 2026 « Let's Play »
// Un Durable Object (stockage SQLite) garde le planning : les ecritures y sont serialisees,
// donc deux personnes ne peuvent pas prendre la derniere place d'un stand en meme temps.
import { DurableObject } from 'cloudflare:workers';

export const STANDS = [
  { id: 'accueil', groupe: 'Accueil', nom: "Accueil, permis de construire et droit à l'image", places: 3 },
  { id: 'defi-01', groupe: 'Les 14 défis', nom: '1. La tour en 1 minute', places: 1 },
  { id: 'defi-02', groupe: 'Les 14 défis', nom: "2. Qu'est-ce qui a changé ?", places: 1 },
  { id: 'defi-03', groupe: 'Les 14 défis', nom: '3. Le sac mystère', places: 1 },
  { id: 'defi-04', groupe: 'Les 14 défis', nom: '4. La pêche aux couleurs', places: 1 },
  { id: 'defi-05', groupe: 'Les 14 défis', nom: '5. La pêche aux briques', places: 1 },
  { id: 'defi-06', groupe: 'Les 14 défis', nom: '6. Les fouilles du chantier', places: 1 },
  { id: 'defi-07', groupe: 'Les 14 défis', nom: '7. Le parcours à bille', places: 1 },
  { id: 'defi-08', groupe: 'Les 14 défis', nom: '8. La course CrossFit', places: 2 },
  { id: 'defi-09', groupe: 'Les 14 défis', nom: '9. La course à la cuillère', places: 1 },
  { id: 'defi-10', groupe: 'Les 14 défis', nom: '10. Le souffle turbo', places: 1 },
  { id: 'defi-11', groupe: 'Les 14 défis', nom: '11. Le chamboule-tout', places: 1 },
  { id: 'defi-12', groupe: 'Les 14 défis', nom: '12. Le bâtisseur aux pieds nus', places: 1 },
  { id: 'defi-13', groupe: 'Les 14 défis', nom: '13. Le guide aveugle', places: 1 },
  { id: 'defi-14', groupe: 'Les 14 défis', nom: '14. Le parachutiste', places: 2 },
  { id: 'nourriture', groupe: 'Stand nourriture', nom: 'Stand nourriture et défi crêpes', places: 3 },
  { id: 'concours-animation', groupe: 'Grand Concours des Bâtisseurs', nom: 'Animation du concours', places: 3 },
  { id: 'concours-jury', groupe: 'Grand Concours des Bâtisseurs', nom: 'Jury du concours', places: 3 },
  { id: 'mise-en-place', groupe: 'Équipes', nom: 'Équipe mise en place, le matin', places: 6 },
  { id: 'securite', groupe: 'Équipes', nom: 'Équipe sécurité', places: 3 },
  { id: 'menage', groupe: 'Équipes', nom: 'Équipe ménage', places: 2 },
  { id: 'renfort', groupe: 'En renfort', nom: 'Disponible là où on aura besoin de moi', places: 20, renfort: true },
];
const PAR_ID = new Map(STANDS.map(s => [s.id, s]));

const INSTANCES = new Set(['live', 'test']);
const LIMITE_ACTIONS = 12;              // actions par adresse IP...
const FENETRE_MS = 10 * 60 * 1000;      // ...sur 10 minutes
const PRENOM_RE = /^\p{L}[\p{L}\p{M} .'’-]{1,39}$/u;
const CONTACT_RE = /(\d[\s.-]?){6,}|@|https?:|www\./i;   // telephone, e-mail ou lien : refuses

class Refus extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async txt => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)));
const normalise = s => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const cleComparaison = s => normalise(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z]/g, '');

function egalTempsConstant(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class Planning extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // requetes SQLite du Durable Object, toujours avec des valeurs liees (?)
    const sql = ctx.storage.sql;
    this.q = (requete, ...valeurs) => sql['exec'](requete, ...valeurs);
    this.q(`CREATE TABLE IF NOT EXISTS inscrits (
      id TEXT PRIMARY KEY, stand TEXT NOT NULL, prenom TEXT NOT NULL, remarque TEXT NOT NULL DEFAULT '',
      cle_hash TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.q('CREATE TABLE IF NOT EXISTS journal (ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)');
    this.q('CREATE TABLE IF NOT EXISTS actions (ip TEXT NOT NULL, ts INTEGER NOT NULL)');
  }

  liste() {
    const inscrits = this.q('SELECT id, stand, prenom, remarque, ts FROM inscrits ORDER BY ts').toArray();
    return { stands: STANDS, inscrits, maj: Date.now() };
  }

  // Limite anti-abus par IP (hachee). Les actions de l'organisation n'y sont pas soumises.
  compteAction(ip) {
    const now = Date.now();
    this.q('DELETE FROM actions WHERE ts < ?', now - FENETRE_MS);
    const n = this.q('SELECT COUNT(*) AS n FROM actions WHERE ip = ?', ip).one().n;
    if (n >= LIMITE_ACTIONS) throw new Refus(429, 'Trop de tentatives depuis cette connexion. Réessaie dans quelques minutes.');
    this.q('INSERT INTO actions (ip, ts) VALUES (?, ?)', ip, now);
  }

  async inscrire({ stand, prenom, remarque }, ip, admin) {
    try {
      // seule attente de la methode, AVANT les controles : controle de capacite et insertion
      // s'enchainent ensuite sans rendre la main, deux inscriptions ne peuvent donc pas se croiser
      const cle = hex(crypto.getRandomValues(new Uint8Array(16)));
      const cleHash = await sha256(cle);
      if (!admin) this.compteAction(ip);
      const s = PAR_ID.get(stand);
      if (!s) throw new Refus(400, 'Stand inconnu. Recharge la page.');
      prenom = normalise(String(prenom || ''));
      remarque = normalise(String(remarque || '')).slice(0, 120);
      if (!PRENOM_RE.test(prenom)) throw new Refus(400, "Écris ton prénom et l'initiale de ton nom (lettres seulement, 2 à 40 caractères).");
      if (CONTACT_RE.test(remarque)) throw new Refus(400, "Pas de numéro de téléphone, d'e-mail ni de lien dans la remarque : la liste est visible par tous.");
      const deja = this.q('SELECT prenom FROM inscrits WHERE stand = ?', stand).toArray();
      if (deja.some(r => cleComparaison(r.prenom) === cleComparaison(prenom))) throw new Refus(409, `${prenom} est déjà inscrit(e) sur ce stand.`);
      if (deja.length >= s.places) throw new Refus(409, s.renfort ? 'La liste des renforts est complète, merci !' : 'Ce stand vient d’être complété. Choisis un autre stand ou inscris-toi en renfort.');
      const id = crypto.randomUUID();
      const ts = Date.now();
      this.q('INSERT INTO inscrits (id, stand, prenom, remarque, cle_hash, ts) VALUES (?, ?, ?, ?, ?, ?)', id, stand, prenom, remarque, cleHash, ts);
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', ts, admin ? 'ajout (organisation)' : 'inscription', `${prenom} | ${s.nom}${remarque ? ' | ' + remarque : ''}`);
      return { id, cle, ...this.liste() };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  async retirer({ id, cle }, ip, admin) {
    try {
      if (!admin) this.compteAction(ip);
      const r = this.q('SELECT stand, prenom, cle_hash FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
      if (!r) throw new Refus(404, 'Cette inscription a déjà été retirée.');
      if (!admin && !egalTempsConstant(await sha256(String(cle || '')), r.cle_hash)) {
        throw new Refus(403, "Tu ne peux retirer que tes propres inscriptions, depuis l'appareil qui a servi à t'inscrire. Sinon, préviens l'organisation.");
      }
      this.q('DELETE FROM inscrits WHERE id = ?', String(id));
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), admin ? 'retrait (organisation)' : 'retrait', `${r.prenom} | ${PAR_ID.get(r.stand)?.nom || r.stand}`);
      return this.liste();
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  journal() {
    return { journal: this.q('SELECT ts, action, detail FROM journal ORDER BY ts DESC LIMIT 500').toArray() };
  }
}

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const autorises = (env.ORIGINES || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = autorises.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Code-Organisation',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } : { Vary: 'Origin' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const entetes = { ...cors(request, env), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    const repondre = (corps, status = 200) => new Response(JSON.stringify(corps), { status, headers: entetes });
    // le Durable Object renvoie { erreur, status } plutot que de lever (les classes d'erreur ne traversent pas l'appel RPC)
    const resultat = (r, ok = 200) => (r && r.erreur ? repondre({ erreur: r.erreur }, r.status || 500) : repondre(r, ok));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: entetes });

    try {
      const instance = url.searchParams.get('instance') || 'live';
      if (!INSTANCES.has(instance)) throw new Refus(400, 'Instance inconnue.');
      const stub = env.PLANNING.get(env.PLANNING.idFromName(instance));
      const code = request.headers.get('X-Code-Organisation') || '';
      const admin = Boolean(env.CODE_ORGANISATION) && egalTempsConstant(code, env.CODE_ORGANISATION);
      if (code && !admin) throw new Refus(403, 'Code organisation incorrect.');
      const ip = await sha256((request.headers.get('CF-Connecting-IP') || '') + '|' + (env.SEL_IP || ''));

      if (request.method === 'GET' && url.pathname === '/api/planning') return repondre(await stub.liste());
      if (request.method === 'GET' && url.pathname === '/api/journal') {
        if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
        return repondre(await stub.journal());
      }
      if (request.method === 'POST' && (url.pathname === '/api/inscription' || url.pathname === '/api/retrait')) {
        const brut = await request.text();
        if (brut.length > 2000) throw new Refus(413, 'Requête trop longue.');
        let corps;
        try { corps = JSON.parse(brut); } catch { throw new Refus(400, 'Requête illisible.'); }
        if (!corps || typeof corps !== 'object') throw new Refus(400, 'Requête illisible.');
        if (corps.site) return repondre({ ok: true });   // champ piege : rempli seulement par les robots
        if (url.pathname === '/api/inscription') return resultat(await stub.inscrire(corps, ip, admin), 201);
        return resultat(await stub.retirer(corps, ip, admin));
      }
      if (url.pathname === '/') return repondre({ service: 'Bénévoles Life Party 2026', ok: true });
      throw new Refus(404, 'Adresse inconnue.');
    } catch (e) {
      return repondre({ erreur: e instanceof Refus ? e.message : 'Erreur du serveur : ' + (e && e.message || 'inconnue') }, e instanceof Refus ? e.status : 500);
    }
  },
};
