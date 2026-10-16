# -*- coding: utf-8 -*-
# Variantes d'une meme adresse comptees ensemble + renvoi par l'organisation (instance test)
import json, sys, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
B = 'https://lifeparty-benevoles.natquinson.workers.dev'
CODE = open('CODE_ORGANISATION.txt').read().strip()
def call(path, body=None, inst='test', admin=True):
    H = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', **({'X-Code-Organisation': CODE} if admin else {})}
    req = urllib.request.Request(f'{B}{path}?instance={inst}', data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET', headers=H)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())
base = {'parent': 'Test Variantes', 'telephone': '06 12 34 56 78', 'enfants': [{'prenom': 'Léa', 'age': 7}], 'photo': 'oui', 'autorite': True, 'signature': 'Test Variantes', 'version': 'lets-play-2026-v1'}
res = []
for e in ['var.iante+1@example.com', 'var.iante+2@example.com', 'VAR.IANTE@example.com', 'var.iante+3@example.com']:
    s, d = call('/api/familles/inscription', {**base, 'email': e}, admin=False); res.append(d.get('email_envoye'))
print('envois (public) :', res)
s, d = call('/api/familles/liste'); fid = d['familles'][-1]['id']
s, d = call('/api/familles/renvoyer', {'id': fid}); print('renvoi organisation ->', s, d)
s, d = call('/api/familles/renvoyer', {'id': fid}, admin=False); print('renvoi sans code ->', s)
s, d = call('/api/familles/liste'); print([j['action'] + ' : ' + j['detail'][:70] for j in d['journal'][:2]])
for f in d['familles']: call('/api/familles/annulation', {'id': f['id']})
print('test vide :', len(call('/api/familles/liste')[1]['familles']), '| live :', len(call('/api/familles/liste', inst='live')[1]['familles']))
print('OK' if res == [True, True, True, False] else 'A VERIFIER')
