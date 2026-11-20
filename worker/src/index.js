// Inscriptions des benevoles Life Party 2026 « Let's Play »
// Un Durable Object (stockage SQLite) garde le planning : les ecritures y sont serialisees,
// donc deux personnes ne peuvent pas prendre la derniere place d'un stand en meme temps.
import { DurableObject } from 'cloudflare:workers';
import qrcode from 'qrcode-generator';

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
const ENVOIS_PAR_ADRESSE = 3;   // e-mails de confirmation par adresse sur 24 h
const ENVOIS_PAR_JOUR = 200;    // plafond global sur 24 h (quota Brevo, abus)
const ENVOIS_PAR_IP = 10;       // par connexion sur 24 h, pour qu'une seule source n'epuise pas le plafond global
// adresse canonique : sans +etiquette, et pour Gmail sans les points (les variantes arrivent dans la meme boite)
function adresseCanonique(email) {
  let [local, domaine = ''] = String(email).trim().toLowerCase().split('@');
  local = local.split('+')[0];
  if (domaine === 'googlemail.com') domaine = 'gmail.com';
  if (domaine === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domaine}`;
}
const ALPHABET_BILLET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nouveauBillet = () => [...crypto.getRandomValues(new Uint8Array(10))].map(b => ALPHABET_BILLET[b % 32]).join('');

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
    // billet d'entree (QR code du parent) et heure d'arrivee le jour J, ajoutes apres la creation de la table
    for (const col of ['billet TEXT', 'arrivee INTEGER', "email TEXT NOT NULL DEFAULT ''"]) {
      try { this.q(`ALTER TABLE familles ADD COLUMN ${col}`); } catch { /* colonne deja presente */ }
    }
    this.q('CREATE UNIQUE INDEX IF NOT EXISTS familles_billet ON familles (billet)');
    this.q('CREATE TABLE IF NOT EXISTS envois (adresse TEXT NOT NULL, ts INTEGER NOT NULL)');
    try { this.q("ALTER TABLE envois ADD COLUMN ip TEXT NOT NULL DEFAULT ''"); } catch { /* colonne deja presente */ }
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
      const email = String(corps.email || '').trim().toLowerCase();
      if (!NOM_RE.test(parent)) throw new Refus(400, 'Indique ton prénom et ton nom (lettres seulement).');
      // adresse simple uniquement : partie locale classique, domaine en etiquettes [a-z0-9-] sans point final
      if (!/^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(email) || email.length > 120) throw new Refus(400, 'Adresse e-mail invalide.');
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
      const billet = nouveauBillet();
      this.q(`INSERT INTO familles (id, parent, telephone, enfants, nb_enfants, photo, signature, version_autorisation, cle_hash, ts, billet, email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, parent, telephone, JSON.stringify(enfants), enfants.length, corps.photo, signature, VERSION_AUTORISATION, cleHash, ts, billet, email);
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', ts, 'inscription', `${parent} | ${enfants.length} enfant(s) | photos : ${corps.photo}`);
      return { id, cle, billet, ts, parent, email, enfants, photo: corps.photo };
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

  // accueil le jour J : par billet scanne (QR) ou par id (bouton de la liste) ; annuler = enlever la coche
  arrivee({ billet, id, annuler }) {
    try {
      const f = billet
        ? this.q('SELECT id, parent, enfants, nb_enfants, photo, arrivee FROM familles WHERE billet = ?', String(billet).toUpperCase()).toArray()[0]
        : this.q('SELECT id, parent, enfants, nb_enfants, photo, arrivee FROM familles WHERE id = ?', String(id || '')).toArray()[0];
      if (!f) throw new Refus(404, 'Billet inconnu : cette inscription n’existe pas ou a été annulée.');
      const famille = { id: f.id, parent: f.parent, enfants: JSON.parse(f.enfants), nb_enfants: f.nb_enfants, photo: f.photo };
      if (annuler) {
        this.q('UPDATE familles SET arrivee = NULL WHERE id = ?', f.id);
        this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), 'arrivée annulée', f.parent);
        return { famille, arrivee: null, deja: false };
      }
      if (f.arrivee) return { famille, arrivee: f.arrivee, deja: true };
      const ts = Date.now();
      this.q('UPDATE familles SET arrivee = ? WHERE id = ?', ts, f.id);
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', ts, 'arrivée', `${f.parent} | ${f.nb_enfants} enfant(s)`);
      return { famille, arrivee: ts, deja: false };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  liste() {
    const familles = this.q('SELECT id, parent, telephone, email, enfants, nb_enfants, photo, signature, version_autorisation, ts, arrivee FROM familles ORDER BY ts').toArray()
      .map(f => ({ ...f, enfants: JSON.parse(f.enfants) }));
    const journal = this.q('SELECT ts, action, detail FROM journal ORDER BY ts DESC LIMIT 300').toArray();
    return { familles, journal, maj: Date.now() };
  }

  // une adresse saisie par un tiers ne doit pas pouvoir etre inondee : le formulaire est public et l'adresse non verifiee
  // l'organisation (renvoi depuis la liste) n'est pas soumise aux plafonds
  async autoriserEnvoi(email, ip, admin) {
    const adresse = await sha256(adresseCanonique(email));
    const now = Date.now();
    this.q('DELETE FROM envois WHERE ts < ?', now - 24 * 3600 * 1000);
    if (!admin) {
      if (this.q('SELECT COUNT(*) AS n FROM envois').one().n >= ENVOIS_PAR_JOUR) return { ok: false, raison: 'plafond journalier des e-mails atteint (renvoyer depuis la liste)' };
      if (this.q('SELECT COUNT(*) AS n FROM envois WHERE ip = ?', ip || '').one().n >= ENVOIS_PAR_IP) return { ok: false, raison: 'trop d’e-mails depuis cette connexion aujourd’hui' };
      if (this.q('SELECT COUNT(*) AS n FROM envois WHERE adresse = ?', adresse).one().n >= ENVOIS_PAR_ADRESSE) return { ok: false, raison: 'trop d’e-mails vers cette adresse aujourd’hui' };
    }
    this.q('INSERT INTO envois (adresse, ts, ip) VALUES (?, ?, ?)', adresse, now, admin ? 'organisation' : (ip || ''));
    return { ok: true };
  }

  // donnees necessaires pour renvoyer le billet par e-mail
  pourEnvoi(id) {
    const f = this.q('SELECT id, parent, email, enfants, photo, billet FROM familles WHERE id = ?', String(id || '')).toArray()[0];
    if (!f) return { erreur: 'Inscription introuvable.', status: 404 };
    if (!f.email) return { erreur: 'Pas d’e-mail pour cette inscription (coordonnées effacées ?).', status: 400 };
    return { ...f, enfants: JSON.parse(f.enfants) };
  }

  noterEnvoi(id, ok, raison) {
    const f = this.q('SELECT parent FROM familles WHERE id = ?', String(id)).toArray()[0];
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), ok ? 'e-mail de confirmation envoyé' : 'ÉCHEC e-mail de confirmation', `${f ? f.parent : id}${raison ? ' | ' + raison : ''}`);
  }

  // apres l'evenement : on efface les coordonnees (telephone, e-mail), on garde les autorisations photo
  effacerTelephones() {
    this.q("UPDATE familles SET telephone = '', email = ''");
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), 'coordonnées effacées (organisation)', '');
    return this.liste();
  }
}

// ---------------------------------------------------------------------------------------------
// Soiree « Au pied du Pere » (12 decembre 2026) : inscriptions avec jauge, adultes et enfants comptes ensemble.
// Liste PRIVEE, lecture reservee a l'organisation (code CODE_SOIREE, distinct du code de la Life Party).
// Complet = inscriptions refusees (pas de liste d'attente). Confirmation par e-mail, sans billet.
// ---------------------------------------------------------------------------------------------
export const SOIREE = {
  id: 'au-pied-du-pere-2026',
  titre: 'Au pied du Père',
  quand: 'Samedi 12 décembre 2026 à 19 h 30',
  lieu: 'Église de Barral, Seynod (Annecy)',
  capacite: 100,                          // jauge de depart, modifiable depuis la page organisation
  fin: Date.UTC(2026, 11, 12, 18, 30),    // 19 h 30 a Annecy : plus d'inscription en ligne ensuite
  page: 'https://choisislavie.org/au-pied-du-pere/',
};
const MAX_ADULTES = 10;
const MAX_ENFANTS_SOIREE = 10;
const NOM_PERSONNE_RE = /^\p{L}[\p{L}\p{M} .'’-]{0,39}$/u;
const VILLE_RE = /^\p{L}[\p{L}\p{M}\d .'’()-]{1,59}$/u;
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

export class Soiree extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.q = (requete, ...valeurs) => sql['exec'](requete, ...valeurs);
    this.q(`CREATE TABLE IF NOT EXISTS inscrits (
      id TEXT PRIMARY KEY, prenom TEXT NOT NULL, nom TEXT NOT NULL, email TEXT NOT NULL, email_canon TEXT NOT NULL,
      adultes INTEGER NOT NULL, enfants INTEGER NOT NULL, ville TEXT NOT NULL, congregation TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL, arrivee INTEGER, par_orga INTEGER NOT NULL DEFAULT 0)`);
    this.q('CREATE TABLE IF NOT EXISTS journal (ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)');
    this.q('CREATE TABLE IF NOT EXISTS actions (ip TEXT NOT NULL, ts INTEGER NOT NULL)');
    this.q("CREATE TABLE IF NOT EXISTS envois (adresse TEXT NOT NULL, ts INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '')");
    this.q('CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)');
  }

  capacite() {
    const r = this.q("SELECT valeur FROM reglages WHERE cle = 'capacite'").toArray()[0];
    return r ? Number(r.valeur) : SOIREE.capacite;
  }

  // etat public : uniquement des nombres (aucune donnee personnelle)
  etat() {
    const capacite = this.capacite();
    const pris = this.q('SELECT COALESCE(SUM(adultes + enfants), 0) AS n FROM inscrits').one().n;
    return { capacite, pris, restantes: Math.max(0, capacite - pris), complet: pris >= capacite, ferme: Date.now() >= SOIREE.fin };
  }

  compteAction(ip) {
    const now = Date.now();
    this.q('DELETE FROM actions WHERE ts < ?', now - FENETRE_MS);
    if (this.q('SELECT COUNT(*) AS n FROM actions WHERE ip = ?', ip).one().n >= LIMITE_ACTIONS) {
      throw new Refus(429, 'Beaucoup d’inscriptions viennent d’être faites depuis ce réseau (Wi-Fi partagé ?). Passez en 4G ou réessayez dans 10 minutes.');
    }
    this.q('INSERT INTO actions (ip, ts) VALUES (?, ?)', ip, now);
  }

  // aucune attente dans cette methode : controle de la jauge et insertion ne peuvent pas se croiser
  inscrire(corps, ip, admin) {
    try {
      if (!admin && Date.now() >= SOIREE.fin) throw new Refus(410, 'Les inscriptions en ligne sont closes.');
      const prenom = normalise(String(corps.prenom || ''));
      const nom = normalise(String(corps.nom || ''));
      const email = String(corps.email || '').trim().toLowerCase();
      const ville = normalise(String(corps.ville || ''));
      const congregation = Array.from(normalise(String(corps.congregation || ''))).slice(0, 81).join('');
      const adultes = Number(corps.adultes);
      const enfants = Number(corps.enfants);
      if (!NOM_PERSONNE_RE.test(prenom)) throw new Refus(400, 'Indiquez votre prénom (lettres seulement).');
      if (!NOM_PERSONNE_RE.test(nom)) throw new Refus(400, 'Indiquez votre nom (lettres seulement).');
      // l'organisation peut ajouter une personne sans e-mail (inscription par telephone, par exemple)
      if ((email || !admin) && (!EMAIL_RE.test(email) || email.length > 120)) throw new Refus(400, 'Adresse e-mail invalide.');
      if (!VILLE_RE.test(ville)) throw new Refus(400, 'Indiquez votre ville d’habitation.');
      if (congregation.length > 80 || /https?:|www\.|@|[<>]/i.test(congregation)) throw new Refus(400, 'Congrégation : 80 caractères au plus, sans lien ni adresse e-mail.');
      if (!Number.isInteger(adultes) || adultes < 1 || adultes > MAX_ADULTES) throw new Refus(400, `Nombre d’adultes : entre 1 et ${MAX_ADULTES}. Pour un groupe plus grand, écrivez à contact@choisislavie.org.`);
      if (!Number.isInteger(enfants) || enfants < 0 || enfants > MAX_ENFANTS_SOIREE) throw new Refus(400, `Nombre d’enfants : entre 0 et ${MAX_ENFANTS_SOIREE}. Pour un groupe plus grand, écrivez à contact@choisislavie.org.`);
      const canon = email ? adresseCanonique(email) : '';
      if (canon && this.q('SELECT COUNT(*) AS n FROM inscrits WHERE email_canon = ?', canon).one().n) {
        throw new Refus(409, 'Une inscription existe déjà avec cette adresse e-mail. Pour la modifier, annulez-la avec le lien reçu par e-mail, puis inscrivez-vous de nouveau.');
      }
      const { restantes } = this.etat();
      if (adultes + enfants > restantes && !(admin && corps.forcer === true)) {
        throw new Refus(409, restantes <= 0 ? 'La soirée est complète : il n’y a plus de place.'
          : `Il ne reste que ${pluriel(restantes, 'place')}. Réduisez le nombre de personnes pour vous inscrire.`);
      }
      if (!admin) this.compteAction(ip);
      const id = crypto.randomUUID();
      const ts = Date.now();
      this.q(`INSERT INTO inscrits (id, prenom, nom, email, email_canon, adultes, enfants, ville, congregation, ts, par_orga)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, prenom, nom, email, canon, adultes, enfants, ville, congregation, ts, admin ? 1 : 0);
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', ts, admin ? 'ajout (organisation)' : 'inscription',
        `${prenom} ${nom} | ${pluriel(adultes, 'adulte')}, ${pluriel(enfants, 'enfant')} | ${ville}${congregation ? ' | ' + congregation : ''}`);
      return { id, ts, prenom, nom, email, adultes, enfants, ville, congregation, ...this.etat() };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  // la cle d'annulation est verifiee par le worker avant l'appel
  resume(id) {
    const r = this.q('SELECT id, prenom, nom, adultes, enfants FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
    return r || { erreur: 'Cette inscription n’existe plus : elle a déjà été annulée.', status: 404 };
  }

  annuler(id, ip, admin) {
    try {
      const r = this.q('SELECT prenom, nom, adultes, enfants FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
      if (!r) throw new Refus(404, 'Cette inscription n’existe plus : elle a déjà été annulée.');
      if (!admin) this.compteAction(ip);
      this.q('DELETE FROM inscrits WHERE id = ?', String(id));
      this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), admin ? 'annulation (organisation)' : 'annulation',
        `${r.prenom} ${r.nom} | ${r.adultes + r.enfants} place(s) libérée(s)`);
      return { ok: true, ...this.etat() };
    } catch (e) {
      return { erreur: e.message, status: e instanceof Refus ? e.status : 500 };
    }
  }

  arrivee({ id, annuler }) {
    const r = this.q('SELECT prenom, nom, adultes, enfants, arrivee FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
    if (!r) return { erreur: 'Inscription introuvable (annulée ?).', status: 404 };
    const ts = annuler ? null : (r.arrivee || Date.now());
    this.q('UPDATE inscrits SET arrivee = ? WHERE id = ?', ts, String(id));
    if (!r.arrivee !== !ts) this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), annuler ? 'arrivée annulée' : 'arrivée', `${r.prenom} ${r.nom}`);
    return { ok: true, arrivee: ts };
  }

  regler({ capacite }) {
    const n = Number(capacite);
    if (!Number.isInteger(n) || n < 1 || n > 2000) return { erreur: 'Jauge : un nombre entier entre 1 et 2000.', status: 400 };
    const avant = this.capacite();
    this.q("INSERT INTO reglages (cle, valeur) VALUES ('capacite', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur", String(n));
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), 'jauge modifiée (organisation)', `${avant} → ${n} places`);
    return this.liste();
  }

  liste() {
    const inscrits = this.q('SELECT id, prenom, nom, email, adultes, enfants, ville, congregation, ts, arrivee, par_orga FROM inscrits ORDER BY ts').toArray();
    const journal = this.q('SELECT ts, action, detail FROM journal ORDER BY ts DESC LIMIT 300').toArray();
    return { inscrits, journal, ...this.etat(), maj: Date.now() };
  }

  // formulaire public, adresse non verifiee : une adresse saisie par un tiers ne doit pas pouvoir etre inondee
  async autoriserEnvoi(email, ip, admin) {
    const adresse = await sha256(adresseCanonique(email));
    const now = Date.now();
    this.q('DELETE FROM envois WHERE ts < ?', now - 24 * 3600 * 1000);
    if (!admin) {
      if (this.q('SELECT COUNT(*) AS n FROM envois').one().n >= ENVOIS_PAR_JOUR) return { ok: false, raison: 'plafond journalier des e-mails atteint (renvoyer depuis la liste)' };
      if (this.q('SELECT COUNT(*) AS n FROM envois WHERE ip = ?', ip || '').one().n >= ENVOIS_PAR_IP) return { ok: false, raison: 'trop d’e-mails depuis cette connexion aujourd’hui' };
      if (this.q('SELECT COUNT(*) AS n FROM envois WHERE adresse = ?', adresse).one().n >= ENVOIS_PAR_ADRESSE) return { ok: false, raison: 'trop d’e-mails vers cette adresse aujourd’hui' };
    }
    this.q('INSERT INTO envois (adresse, ts, ip) VALUES (?, ?, ?)', adresse, now, admin ? 'organisation' : (ip || ''));
    return { ok: true };
  }

  pourEnvoi(id) {
    const r = this.q('SELECT id, prenom, nom, email, adultes, enfants, ville, congregation FROM inscrits WHERE id = ?', String(id || '')).toArray()[0];
    if (!r) return { erreur: 'Inscription introuvable.', status: 404 };
    if (!r.email) return { erreur: 'Pas d’e-mail pour cette inscription.', status: 400 };
    return r;
  }

  noterEnvoi(id, ok, raison) {
    const r = this.q('SELECT prenom, nom FROM inscrits WHERE id = ?', String(id)).toArray()[0];
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), ok ? 'e-mail de confirmation envoyé' : 'ÉCHEC e-mail de confirmation',
      `${r ? r.prenom + ' ' + r.nom : id}${raison ? ' | ' + raison : ''}`);
  }

  // apres la soiree : on efface les e-mails, on garde les noms, villes et congregations (bilan)
  effacerCoordonnees() {
    this.q("UPDATE inscrits SET email = '', email_canon = ''");
    this.q('INSERT INTO journal (ts, action, detail) VALUES (?, ?, ?)', Date.now(), 'e-mails effacés (organisation)', '');
    return this.liste();
  }
}

// cle d'annulation derivee de l'identifiant (HMAC) : rien a stocker, valable depuis l'e-mail comme depuis l'appareil
async function cleAnnulation(env, instance, id) {
  if (!env.SEL_IP) throw new Error('configuration incomplète (SEL_IP)');
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SEL_IP), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`annulation|${SOIREE.id}|${instance}|${id}`))).slice(0, 32);
}
const lienAnnulation = (instance, id, cle) => `${SOIREE.page}${instance === 'test' ? '?test' : ''}#annuler=${id}.${cle}`;

function courrielSoiree(d, instance, cle) {
  const places = d.adultes + d.enfants;
  const lignes = [pluriel(d.adultes, 'adulte'), d.enfants ? pluriel(d.enfants, 'enfant') : null].filter(Boolean).join(' et ');
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#EEE8DF;font-family:Arial,Helvetica,sans-serif;color:#141A3A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEE8DF;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="background:#1B2350;background-image:linear-gradient(135deg,#C9692A 0%,#7A4A4F 38%,#1B2350 75%);padding:30px 28px 26px;">
<p style="margin:0 0 10px;font-size:12px;letter-spacing:3px;font-weight:bold;color:#F6EFE4;text-transform:uppercase;">Soirée de réveil &amp; d'adoration</p>
<h1 style="margin:0;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:36px;line-height:1.05;color:#F6EFE4;text-transform:uppercase;">Au pied du Père</h1>
<p style="margin:14px 0 0;font-size:16px;font-weight:bold;color:#F2B33D;">Samedi 12 décembre 2026, 19 h 30</p>
<p style="margin:4px 0 0;font-size:15px;color:#F6EFE4;">${echapper(SOIREE.lieu)}</p></td></tr>
<tr><td style="padding:26px 28px 6px;font-size:15px;line-height:1.6;">
<p style="margin:0 0 10px;">Bonjour ${echapper(d.prenom)},</p>
<p style="margin:0 0 14px;">Votre inscription est confirmée. Nous avons réservé <b>${pluriel(places, 'place')}</b> pour vous : ${lignes}.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#F6F1E8;border-radius:12px;"><tr><td style="padding:14px 16px;font-size:14px;line-height:1.7;">
<b>Invité :</b> Dr Francesco, du Canada<br><b>Entrée :</b> gratuite, une offrande sera proposée<br>
<b>Inscription au nom de :</b> ${echapper(d.prenom)} ${echapper(d.nom)}, ${echapper(d.ville)}${d.congregation ? `<br><b>Congrégation :</b> ${echapper(d.congregation)}` : ''}
</td></tr></table></td></tr>
<tr><td style="padding:18px 28px 4px;font-size:15px;line-height:1.6;">
<p style="margin:0 0 14px;">Un empêchement ? Les places sont limitées : merci d'annuler votre inscription pour les laisser à d'autres.</p>
<a href="${lienAnnulation(instance, d.id, cle)}" style="display:inline-block;background:#141A3A;color:#F6EFE4;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:999px;font-size:14px;">Annuler mon inscription</a></td></tr>
<tr><td style="padding:22px 28px 26px;font-size:14px;line-height:1.6;color:#5B5F75;">
<p style="margin:0 0 10px;font-style:italic;">« Comme il était encore loin, son père le vit et fut ému de compassion. » Luc 15:20</p>
<p style="margin:0;">À très bientôt,<br><b style="color:#141A3A;">Cœurs d'Espoir et Choisis la Vie</b>, en collaboration avec HUB mvmnt</p></td></tr>
</table></td></tr></table></body></html>`;
  return { to: d.email, toName: `${d.prenom} ${d.nom}`, fromName: 'Choisis la Vie', subject: 'Inscription confirmée : soirée « Au pied du Père » du 12 décembre', html };
}

async function envoyerConfirmationSoiree(env, d, instance) {
  if (!env.COURRIEL || !env.SECRET_INTERNE) return { ok: false, raison: 'envoi non configuré' };
  try {
    const cle = await cleAnnulation(env, instance, d.id);
    const r = await env.COURRIEL.fetch('https://interne/interne/envoi', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Interne': env.SECRET_INTERNE },
      body: JSON.stringify(courrielSoiree(d, instance, cle)),
    });
    if (!r.ok) return { ok: false, raison: `envoi ${r.status} ${(await r.text()).slice(0, 120)}` };
    return { ok: true };
  } catch (e) { return { ok: false, raison: e.message }; }
}

async function routeSoiree(request, env, url, instance, ip, repondre, resultat) {
  const code = request.headers.get('X-Code-Organisation') || '';
  const admin = Boolean(env.CODE_SOIREE) && egalTempsConstant(code, env.CODE_SOIREE);
  if (code && !admin) throw new Refus(403, 'Code organisation incorrect.');
  const soiree = env.SOIREE.get(env.SOIREE.idFromName(`${SOIREE.id}:${instance}`));
  const action = url.pathname.slice('/api/soiree/'.length);
  if (request.method === 'GET' && action === 'etat') return repondre(await soiree.etat());
  if (request.method === 'GET' && action === 'liste') {
    if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
    return repondre(await soiree.liste());
  }
  if (request.method !== 'POST' || !['inscription', 'consulter', 'annulation', 'arrivee', 'renvoyer', 'reglages', 'effacer-coordonnees'].includes(action)) {
    throw new Refus(404, 'Adresse inconnue.');
  }
  const brut = await request.text();
  if (brut.length > 2000) throw new Refus(413, 'Requête trop longue.');
  let corps;
  try { corps = JSON.parse(brut); } catch { throw new Refus(400, 'Requête illisible.'); }
  if (!corps || typeof corps !== 'object') throw new Refus(400, 'Requête illisible.');
  if (corps.site) return repondre({ ok: true });   // champ piege : rempli seulement par les robots

  if (action === 'inscription') {
    const r = await soiree.inscrire(corps, ip, admin);
    if (r && r.erreur) return resultat(r);
    const cle = await cleAnnulation(env, instance, r.id);
    let envoi = { ok: false, raison: 'pas d’e-mail' };
    if (r.email) {
      const permis = await soiree.autoriserEnvoi(r.email, ip, admin);
      envoi = permis.ok ? await envoyerConfirmationSoiree(env, r, instance) : permis;
      await soiree.noterEnvoi(r.id, envoi.ok, envoi.raison);
    }
    return repondre({ ...r, cle, email_envoye: envoi.ok }, 201);
  }
  if (action === 'consulter' || action === 'annulation') {
    const id = String(corps.id || '');
    if (!admin && !egalTempsConstant(String(corps.cle || ''), await cleAnnulation(env, instance, id))) {
      throw new Refus(403, 'Lien d’annulation invalide. Utilisez le lien reçu par e-mail ou écrivez à contact@choisislavie.org.');
    }
    return resultat(action === 'consulter' ? await soiree.resume(id) : await soiree.annuler(id, ip, admin));
  }
  if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
  if (action === 'arrivee') return resultat(await soiree.arrivee(corps));
  if (action === 'reglages') return resultat(await soiree.regler(corps));
  if (action === 'renvoyer') {
    const d = await soiree.pourEnvoi(corps.id);
    if (d.erreur) return resultat(d);
    await soiree.autoriserEnvoi(d.email, ip, true);
    const envoi = await envoyerConfirmationSoiree(env, d, instance);
    await soiree.noterEnvoi(d.id, envoi.ok, envoi.raison ? `renvoi : ${envoi.raison}` : 'renvoi');
    return envoi.ok ? repondre({ ok: true }) : repondre({ erreur: 'Envoi impossible : ' + envoi.raison }, 502);
  }
  return repondre(await soiree.effacerCoordonnees());
}

const URL_ACCUEIL = 'https://choisislavie.org/life-party/lets-play/inscription/accueil/';
const API_PUBLIQUE = 'https://lifeparty-benevoles.natquinson.workers.dev';
const echapper = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlBillet = (billet, instance) => `${URL_ACCUEIL}${instance === 'test' ? '?test' : ''}#b=${billet}`;

function imageBillet(texte) {
  const q = qrcode(0, 'M'); q.addData(texte); q.make();
  const b64 = q.createDataURL(8, 3).split(',')[1];
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function courrielBillet(d, instance) {
  const img = `${API_PUBLIQUE}/api/familles/qr/${d.billet}.gif${instance === 'test' ? '?instance=test' : ''}`;
  const enfants = d.enfants.map(e => `<li>${echapper(e.prenom)}, ${e.age} ans</li>`).join('');
  const photo = d.photo === 'oui' ? 'autorisées' : 'non autorisées (ton choix sera respecté)';
  const html = `<!DOCTYPE html><html lang="fr"><body style="margin:0;padding:0;background:#F7F3ED;font-family:Arial,Helvetica,sans-serif;color:#15120F;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3ED;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td align="center" style="padding:24px 24px 8px;"><img src="https://choisislavie.org/wp-content/uploads/2026/09/life-party-logo-hd-450.png" width="110" alt="Life Party" style="display:block;border:0;"></td></tr>
<tr><td style="padding:8px 28px 0;text-align:center;"><h1 style="margin:0 0 6px;font-family:Georgia,serif;font-size:26px;">Inscription confirmée</h1>
<p style="margin:0;font-size:15px;color:#6B6359;">Life Party « Let's Play »<br><b style="color:#15120F;">Samedi 31 octobre 2026, de 14 h à 17 h</b><br>91 rue Marius Berliet, 01000 Bourg-en-Bresse</p></td></tr>
<tr><td style="padding:20px 28px 0;font-size:15px;line-height:1.6;"><p style="margin:0 0 6px;">Bonjour ${echapper(d.parent)},</p>
<p style="margin:0 0 6px;">Merci pour ton inscription ! Voici les enfants inscrits :</p><ul style="margin:0 0 10px;padding-left:20px;">${enfants}</ul>
<p style="margin:0;">Photos et vidéos : <b>${photo}</b></p></td></tr>
<tr><td align="center" style="padding:22px 28px;"><table role="presentation" cellpadding="0" cellspacing="0" style="border:2px dashed #15120F;border-radius:16px;"><tr><td align="center" style="padding:16px 22px;">
<p style="margin:0 0 6px;font-family:Georgia,serif;font-size:19px;font-weight:bold;">Ton billet d'entrée</p>
<img src="${img}" width="220" height="220" alt="QR code du billet ${d.billet}" style="display:block;border:0;margin:0 auto;">
<p style="margin:8px 0 0;font-family:Consolas,monospace;font-size:18px;font-weight:bold;letter-spacing:3px;">${d.billet}</p>
<p style="margin:6px 0 0;font-size:13px;color:#6B6359;">Montre ce QR code (ou ce code) à l'accueil le jour J.</p></td></tr></table></td></tr>
<tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.6;color:#6B6359;"><p style="margin:0 0 8px;">Pense aux déguisements ! Pour modifier ou annuler l'inscription, réponds simplement à cet e-mail.</p>
<p style="margin:0;">À très vite,<br><b style="color:#15120F;">L'équipe Life Party</b> (Choisis la Vie et l'association EEPV)</p></td></tr>
</table></td></tr></table></body></html>`;
  return { to: d.email, toName: d.parent, subject: "Ton billet pour la Life Party « Let's Play » du 31 octobre", html };
}

async function envoyerBillet(env, d, instance) {
  if (!env.COURRIEL || !env.SECRET_INTERNE) return { ok: false, raison: 'envoi non configuré' };
  try {
    const r = await env.COURRIEL.fetch('https://interne/interne/envoi', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Secret-Interne': env.SECRET_INTERNE },
      body: JSON.stringify(courrielBillet(d, instance)),
    });
    if (!r.ok) return { ok: false, raison: `envoi ${r.status} ${(await r.text()).slice(0, 120)}` };
    return { ok: true };
  } catch (e) { return { ok: false, raison: e.message }; }
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
      // soiree « Au pied du Pere » : son propre code organisation (CODE_SOIREE)
      if (url.pathname.startsWith('/api/soiree/')) {
        const ipSoiree = await sha256((request.headers.get('CF-Connecting-IP') || '') + '|' + (env.SEL_IP || ''));
        return await routeSoiree(request, env, url, instance, ipSoiree, repondre, resultat);
      }
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
        // image QR du billet (pour l'e-mail) : ne revele rien d'autre que le code du billet
        const mq = action.match(/^qr\/([A-Z0-9]{10})\.gif$/);
        if (request.method === 'GET' && mq) {
          return new Response(imageBillet(urlBillet(mq[1], instance)), { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=86400' } });
        }
        if (request.method === 'GET' && action === 'liste') {
          if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
          return repondre(await familles.liste());
        }
        if (request.method === 'POST' && ['inscription', 'annulation', 'effacer-telephones', 'arrivee', 'renvoyer'].includes(action)) {
          const brut = await request.text();
          if (brut.length > 4000) throw new Refus(413, 'Requête trop longue.');
          let corps;
          try { corps = JSON.parse(brut); } catch { throw new Refus(400, 'Requête illisible.'); }
          if (!corps || typeof corps !== 'object') throw new Refus(400, 'Requête illisible.');
          if (corps.site) return repondre({ ok: true });   // champ piege
          if (action === 'inscription') {
            const r = await familles.inscrire(corps, ip, admin);
            if (r && r.erreur) return resultat(r);
            const permis = await familles.autoriserEnvoi(r.email, ip, admin);
            const envoi = permis.ok ? await envoyerBillet(env, r, instance) : permis;
            await familles.noterEnvoi(r.id, envoi.ok, envoi.raison);
            return repondre({ ...r, email_envoye: envoi.ok }, 201);
          }
          if (action === 'annulation') return resultat(await familles.annuler(corps, ip, admin));
          if (!admin) throw new Refus(403, 'Réservé à l’organisation.');
          if (action === 'arrivee') return resultat(await familles.arrivee(corps));
          if (action === 'renvoyer') {
            const d = await familles.pourEnvoi(corps.id);
            if (d.erreur) return resultat(d);
            await familles.autoriserEnvoi(d.email, ip, true);
            const envoi = await envoyerBillet(env, d, instance);
            await familles.noterEnvoi(d.id, envoi.ok, envoi.raison ? `renvoi : ${envoi.raison}` : 'renvoi');
            return envoi.ok ? repondre({ ok: true }) : repondre({ erreur: 'Envoi impossible : ' + envoi.raison }, 502);
          }
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
