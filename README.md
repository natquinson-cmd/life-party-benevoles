# Bénévoles Life Party 2026 « Let's Play »

Page d'inscription des bénévoles : chacun choisit un stand et écrit son prénom, sans compte ni mot de passe.

- Page : https://natquinson-cmd.github.io/life-party-benevoles/
- Mode test (ne touche pas la vraie liste) : https://natquinson-cmd.github.io/life-party-benevoles/?test
- API : https://lifeparty-benevoles.natquinson.workers.dev/api/planning

## Fonctionnement

- `index.html` : la page (GitHub Pages), sans dépendance.
- `worker/` : Worker Cloudflare + Durable Object (stockage SQLite). Les écritures sont sérialisées, deux personnes ne peuvent donc pas prendre la dernière place d'un stand en même temps.
- Les stands et leur nombre de places sont définis dans `worker/src/index.js` (`STANDS`). Après une modification : `npx wrangler deploy` dans `worker/`.
- Chaque inscription reçoit une clé gardée sur l'appareil de la personne, qui peut ainsi se retirer elle-même.
- Mode organisation : lien `…/#organisation=CODE` ou bouton « Accès organisation » en bas de page. Il permet de retirer n'importe qui, de télécharger la liste (CSV pour Excel), d'imprimer et de consulter l'historique.
- Garde-fous : prénom de 2 à 40 lettres, pas de téléphone, d'e-mail ni de lien dans la précision, pas de doublon sur un stand, 12 actions max par connexion toutes les 10 minutes, champ piège anti-robots.

## Secrets (jamais dans le dépôt)

`CODE_ORGANISATION` et `SEL_IP` sont des secrets du Worker (`npx wrangler secret put …`).

## Tests

`python tests_api.py` lance les tests de l'API sur l'instance `test` uniquement.

## Soirée « Au pied du Père » (12 décembre 2026)

Le même Worker porte les inscriptions de la soirée de réveil et d'adoration (Durable Object `Soiree`, routes `/api/soiree/…`).

- Page publique (lien du QR code, absente des menus et du sitemap) : https://choisislavie.org/au-pied-du-pere/ (source dans `site-choisislavie/au-pied-du-pere/`, publiée par `wrangler pages deploy`).
- Page organisation : `/au-pied-du-pere/organisation/#organisation=CODE`, code = secret `CODE_SOIREE` (distinct de `CODE_ORGANISATION`, copie locale gitignorée `CODE_SOIREE.txt`).
- Jauge : 100 places au départ, adultes et enfants comptés ensemble, modifiable depuis la page organisation. Complet = inscriptions refusées. Fermeture automatique le 12/12/2026 à 19 h 30.
- Champs : prénom, nom, e-mail, ville, congrégation (facultative), nombre d'adultes et d'enfants. Une inscription par adresse e-mail.
- E-mail de confirmation (sans billet) via le Worker de contact, avec un lien d'annulation `#annuler=ID.CLE` (clé HMAC dérivée de `SEL_IP`, rien à stocker).
- Tests : `python tests_soiree.py` (instance `test` uniquement).
