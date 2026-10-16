# -*- coding: utf-8 -*-
# Verifie la limite de 3 e-mails par adresse (instance test). Attend que la nouvelle version du DO reponde.
import json, sys, time, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
B = 'https://lifeparty-benevoles.natquinson.workers.dev'
CODE = open('CODE_ORGANISATION.txt').read().strip()
H = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'X-Code-Organisation': CODE}
def call(path, body=None, inst='test'):
    req = urllib.request.Request(f'{B}{path}?instance={inst}', data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET', headers=H)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())
base = {'parent': 'Test Limite', 'email': 'limite.lifeparty@example.com', 'telephone': '06 12 34 56 78', 'enfants': [{'prenom': 'Léa', 'age': 7}],
        'photo': 'oui', 'autorite': True, 'signature': 'Test Limite', 'version': 'lets-play-2026-v1'}
res = []
for i in range(4):
    s, d = call('/api/familles/inscription', base); res.append((s, d.get('email_envoye'), d.get('erreur')))
print(res)
s, d = call('/api/familles/liste'); print([j['detail'] for j in d['journal'][:2]])
for f in d['familles']: call('/api/familles/annulation', {'id': f['id']})
print('test vide :', len(call('/api/familles/liste')[1]['familles']), '| live :', len(call('/api/familles/liste', inst='live')[1]['familles']))
print('LIMITE OK' if [r[1] for r in res] == [True, True, True, False] else 'A VERIFIER')
