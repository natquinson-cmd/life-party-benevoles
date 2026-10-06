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
