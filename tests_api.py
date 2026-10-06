# -*- coding: utf-8 -*-
# Tests fonctionnels de l'API benevoles, TOUJOURS sur l'instance de test (jamais 'live')
import json, sys, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
B = 'https://lifeparty-benevoles.natquinson.workers.dev'
CODE = open('CODE_ORGANISATION.txt').read().strip()
def call(path, body=None, admin=False, inst='test'):
    req = urllib.request.Request(f'{B}{path}?instance={inst}', data=json.dumps(body).encode() if body is not None else None,
        method='POST' if body is not None else 'GET',
        headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 tests-benevoles', 'Origin': 'https://natquinson-cmd.github.io',
                 **({'X-Code-Organisation': CODE} if admin else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        t = e.read()
        try: return e.code, json.loads(t)
        except Exception: return e.code, {'erreur': t[:120]}
# remise a zero de l'instance de test
for i in call('/api/planning')[1]['inscrits']: call('/api/retrait', {'id': i['id']}, admin=True)
ok = True
def verif(nom, cond, info=''):
    global ok; ok &= bool(cond); print(('OK  ' if cond else 'ECHEC ') + nom, info)
s, d = call('/api/inscription', {'stand': 'defi-01', 'prenom': 'Testeur T.', 'remarque': 'plutôt le matin'}, admin=True); mine = (d.get('id'), d.get('cle'))
verif('inscription', s == 201 and mine[1], s)
s, d = call('/api/inscription', {'stand': 'defi-01', 'prenom': 'Autre A.'}, admin=True); verif('stand plein refuse', s == 409, d.get('erreur'))
s, d = call('/api/inscription', {'stand': 'defi-08', 'prenom': 'testeur t'}, admin=True); other = (d.get('id'), d.get('cle')); verif('meme personne sur un autre stand', s == 201, s)
s, d = call('/api/inscription', {'stand': 'defi-08', 'prenom': 'Testeur T'}, admin=True); verif('doublon refuse', s == 409, d.get('erreur'))
s, d = call('/api/inscription', {'stand': 'accueil', 'prenom': 'Bob B.', 'remarque': 'appelle 06 12 34 56 78'}, admin=True); verif('telephone refuse', s == 400, d.get('erreur'))
s, d = call('/api/inscription', {'stand': 'accueil', 'prenom': '<script>'}, admin=True); verif('prenom invalide refuse', s == 400, d.get('erreur'))
s, d = call('/api/inscription', {'stand': 'inconnu', 'prenom': 'Bob B.'}, admin=True); verif('stand inconnu refuse', s == 400, d.get('erreur'))
s, d = call('/api/inscription', {'stand': 'accueil', 'prenom': 'Robot R.', 'site': 'x'}, admin=True); verif('champ piege ignore', s == 200 and not any(i['prenom'] == 'Robot R.' for i in call('/api/planning')[1]['inscrits']))
s, d = call('/api/retrait', {'id': mine[0], 'cle': 'faux'}); verif('retrait avec mauvaise cle refuse', s == 403, d.get('erreur'))
s, d = call('/api/retrait', {'id': mine[0], 'cle': mine[1]}); verif('retrait avec sa cle', s == 200 and all(i['id'] != mine[0] for i in d['inscrits']))
s, d = call('/api/retrait', {'id': other[0]}, admin=True); verif('retrait par organisation', s == 200 and not d['inscrits'])
s, d = call('/api/journal', admin=True); verif('journal organisation', s == 200 and len(d['journal']) >= 4, [j['action'] for j in d['journal'][:4]])
s, d = call('/api/journal'); verif('journal sans code refuse', s == 403, d.get('erreur'))
s, d = call('/api/planning', admin=False, inst='prod'); verif('instance inconnue refusee', s == 400, d.get('erreur'))
req = urllib.request.Request(f'{B}/api/planning?instance=test', headers={'User-Agent': 'Mozilla/5.0', 'X-Code-Organisation': 'mauvais'})
try: urllib.request.urlopen(req); verif('mauvais code refuse', False)
except urllib.error.HTTPError as e: verif('mauvais code refuse', e.code == 403)
print('TOUT EST BON' if ok else 'DES TESTS ECHOUENT')
