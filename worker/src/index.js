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
const LIMITE_ACTIONS = 40;              // actions abouties par adresse IP (Wi-Fi d'eglise partage)...
const FENETRE_MS = 10 * 60 * 1000;      // ...sur 10 minutes
const PRENOM_RE = /^\p{L}[\p{L}\p{M} .'’-]{1,39}$/u;
const CONTACT_RE = /(\d[\s.-]?){6,}|@|https?:|www\./i;   // telephone, e-mail ou lien : refuses

class Refus extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async txt => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt)));
// NFKC + suppression des caracteres invisibles (formatage, fillers coreens) et des marques combinantes empilees
const normalise = s => s.normalize('NFKC').replace(/[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim();
const cleComparaison = s => normalise(s).normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}]/gu, '');

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
    if (n >= LIMITE_ACTIONS) throw new Refus(429, 'Beaucoup d’inscriptions viennent d’être faites depuis ce réseau (Wi-Fi partagé ?). Passe en 4G ou réessaie dans 10 minutes.');
    this.q('INSERT INTO actions (ip, ts) VALUES (?, ?)', ip, now);
  }

  async inscrire({ stand, prenom, remarque }, ip, admin) {
    try {
      // seule attente de la methode, AVANT les controles : controle de capacite et insertion
      // s'enchainent ensuite sans rendre la main, deux inscriptions ne peuvent donc pas se croiser
      const cle = hex(crypto.getRandomValues(new Uint8Array(16)));
      const cleHash = await sha256(cle);
      const s = PAR_ID.get(stand);
      if (!s) throw new Refus(400, 'Stand inconnu. Recharge la page.');
      prenom = normalise(String(prenom || ''));
      remarque = Array.from(normalise(String(remarque || ''))).slice(0, 120).join('');
      if (!PRENOM_RE.test(prenom)) throw new Refus(400, "Écris ton prénom et l'initiale de ton nom (lettres seulement, 2 à 40 caractères).");
      if (CONTACT_RE.test(remarque)) throw new Refus(400, "Pas de numéro de téléphone, d'e-mail ni de lien dans la remarque : la liste est visible par tous.");
      const deja = this.q('SELECT prenom FROM inscrits WHERE stand = ?', stand).toArray();
      if (deja.some(r => cleComparaison(r.prenom) === cleComparaison(prenom))) throw new Refus(409, `${prenom} est déjà inscrit(e) sur ce stand.`);
      if (deja.length >= s.places) throw new Refus(409, s.renfort ? 'La liste des renforts est complète, merci !' : 'Ce stand vient d’être complété. Choisis un autre stand ou inscris-toi en renfort.');
      if (!admin) this.compteAction(ip);
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
      const r = this.q('SELECT stand, prenom, cle_hash FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
      if (!r) throw new Refus(404, 'Cette inscription a déjà été retirée.');
      if (!admin && !egalTempsConstant(await sha256(String(cle || '')), r.cle_hash)) {
        throw new Refus(403, "Tu ne peux retirer que tes propres inscriptions, depuis l'appareil qui a servi à t'inscrire. Sinon, préviens l'organisation.");
      }
      if (!admin) this.compteAction(ip);
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

// ---------------------------------------------------------------------------------------------
// Inscriptions des familles (enfants + autorisation photo). Liste PRIVEE : lecture reservee a l'organisation.
// ---------------------------------------------------------------------------------------------
const VERSION_AUTORISATION = 'lets-play-2026-v1';   // texte d'autorisation affiche sur la page au moment de la signature
const NOM_RE = /^\p{L}[\p{L}\p{M} .'’-]{1,59}$/u;
const PRENOM_ENFANT_RE = /^\p{L}[\p{L}\p{M} .'’-]{0,29}$/u;
const MAX_ENFANTS = 8;

export class Familles extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.q = (requete, ...valeurs) => sql['exec'](requete, ...valeurs);
    this.q(`CREATE TABLE IF NOT EXISTS familles (
      id TEXT PRIMARY KEY, parent TEXT NOT NULL, telephone TEXT NOT NULL, enfants TEXT NOT NULL, nb_enfants INTEGER NOT NULL,
      photo TEXT NOT NULL, signature TEXT NOT NULL, version_autorisation TEXT NOT NULL, cle_hash TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.q('CREATE TABLE IF NOT EXISTS journal (ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)');
    this.q('CREATE TABLE IF NOT EXISTS actions (ip TEXT NOT NULL, ts INTEGER NOT NULL)');
  }

  compteAction(ip) {
    const now = Date.now();
    this.q('DELETE FROM actions WHERE ts < ?', now - FENETRE_MS);
    if (this.q('SELECT COUNT(*) AS n FROM actions WHERE ip = ?', ip).one().n >= LIMITE_ACTIONS) {
      throw new Refus(429, 'Beaucoup d’inscriptions viennent d’être faites depuis ce réseau (Wi-Fi partagé ?). Passe en 4G ou réessaie dans 10 minutes.');
    }
    this.q('INSERT INTO actions (ip, ts) VALUES (?, ?)', ip, now);
  }

  async inscrire(corps, ip, admin) {
    try {
      const cle = hex(crypto.getRandomValues(new Uint8Array(16)));
      const cleHash = await sha256(cle);
      const parent = normalise(String(corps.parent || ''));
      const telephone = normalise(String(corps.telephone || ''));
      const signature = normalise(String(corps.signature || ''));
      if (!NOM_RE.test(parent)) throw new Refus(400, 'Indique ton prénom et ton nom (lettres seulement).');
      const chiffres = telephone.replace(/\D/g, '');
      if (!/^\+?[0-9 .()-]{8,22}$/.test(telephone) || chiffres.length < 9 || chiffres.length > 15) throw new Refus(400, 'Numéro de téléphone invalide.');
      if (!Array.isArray(corps.enfants) || !corps.enfants.length) throw new Refus(400, 'Ajoute au moins un enfant.');
      if (corps.enfants.length > MAX_ENFANTS) throw new Refus(400, `Au maximum ${MAX_ENFANTS} enfants par inscription.`);
      const enfants = corps.enfants.map(e => ({ prenom: normalise(String((e && e.prenom) || '')), age: Number(e && e.age) }));
      for (const e of enfants) {
        if (!PRENOM_ENFANT_RE.test(e.prenom)) throw new Refus(400, 'Indique le prénom de chaque enfant (lettres seulement).');
        if (!Number.isInteger(e.age) || e.age < 1 || e.age > 17) throw new Refus(400, `Indique l’âge de ${e.prenom || 'chaque enfant'} (entre 1 et 17 ans).`);
      }
      if (corps.photo !== 'oui' && corps.photo !== 'non') throw new Refus(400, 'Réponds à la question sur les photos (oui ou non).');
      if (corps.autorite !== true) throw new Refus(400, 'Coche la case confirmant que tu exerces l’autorité parentale.');
      if (signature.length < 3 || signature.length > 60) throw new Refus(400, 'Signe en écrivant ton prénom et ton nom.');
      if (corps.version !== VERSION_AUTORISATION) throw new Refus(409, 'La page a été mise à jour. Recharge-la puis recommence.');
      if (!admin) this.compteAction(ip);
      const id = crypto.randomUUID();
      const ts = Date.now();
      this.q(`INSERT INTO familles (id, parent, telephone, enfants, nb_enfants, photo, signature, version_autorisation, cle_hash, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, parent, telephone, JSON.stringify(enfants), enfants.length, corps.photo, signature, VERSION_AUTORISATION, cleHash, ts);
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', ts, 'inscription', `${parent} | ${enfants.length} enfant(s) | photos : ${corps.photo}`);
      return { id, cle, ts, parent, enfants, photo: corps.photo };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  async annuler({ id, cle }, ip, admin) {
    try {
      const r = this.q('SELECT parent, cle_hash FROM familles WHERE id = ?', String(id || '')).toArray()[0];
      if (!r) throw new Refus(404, 'Cette inscription a déjà été annulée.');
      if (!admin && !egalTempsConstant(await sha256(String(cle || '')), r.cle_hash)) {
        throw new Refus(403, "Tu ne peux annuler que ta propre inscription, depuis l'appareil qui a servi à la faire. Sinon, écris à contact@choisislavie.org.");
      }
      if (!admin) this.compteAction(ip);
      this.q('DELETE FROM familles WHERE id = ?', String(id));
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), admin ? 'annulation (organisation)' : 'annulation', r.parent);
      return { ok: true };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  liste() {
    const familles = this.q('SELECT id, parent, telephone, enfants, nb_enfants, photo, signature, version_autorisation, ts FROM familles ORDER BY ts').toArray()
      .map(f => ({ ...f, enfants: JSON.parse(f.enfants) }));
    const journal = this.q('SELECT ts, action, detail FROM journal ORDER BY ts DESC LIMIT 300').toArray();
    return { familles, journal, maj: Date.now() };
  }

  // apres l'evenement : on efface les telephones, on garde les autorisations photo
  effacerTelephones() {
    this.q("UPDATE familles SET telephone = ''");
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), 'téléphones effacés (organisation)', '');
    return this.liste();
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
      if (url.pathname.startsWith('/api/familles/')) {
        const familles = env.FAMILLES.get(env.FAMILLES.idFromName(instance));
        const action = url.pathname.slice('/api/familles/'.length);
        if (request.method === 'GET' && action === 'liste') {
          if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
          return repondre(await familles.liste());
        }
        if (request.method === 'POST' && ['inscription', 'annulation', 'effacer-telephones'].includes(action)) {
          const brut = await request.text();
          if (brut.length > 4000) throw new Refus(413, 'Requête trop longue.');
          let corps;
          try { corps = JSON.parse(brut); } catch { throw new Refus(400, 'Requête illisible.'); }
          if (!corps || typeof corps !== 'object') throw new Refus(400, 'Requête illisible.');
          if (corps.site) return repondre({ ok: true });   // champ piege
          if (action === 'inscription') return resultat(await familles.inscrire(corps, ip, admin), 201);
          if (action === 'annulation') return resultat(await familles.annuler(corps, ip, admin));
          if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
          return repondre(await familles.effacerTelephones());
        }
        throw new Refus(404, 'Adresse inconnue.');
      }
      if (url.pathname === '/') return repondre({ service: 'Bénévoles Life Party 2026', ok: true });
      throw new Refus(404, 'Adresse inconnue.');
    } catch (e) {
      return repondre({ erreur: e instanceof Refus ? e.message : 'Erreur du serveur : ' + (e && e.message || 'inconnue') }, e instanceof Refus ? e.status : 500);
    }
  },
};
