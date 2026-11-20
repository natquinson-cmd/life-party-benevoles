# -*- coding: utf-8 -*-
# Tests de l'API de la soiree « Au pied du Pere » : instance TEST uniquement (la liste live n'est jamais modifiee).
# python tests_soiree.py        -> tous les cas, puis remise a zero de l'instance test
import json, sys, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
B = 'https://lifeparty-benevoles.natquinson.workers.dev'
CODE = open('CODE_SOIREE.txt').read().strip()
BASE_H = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://choisislavie.org'}
echecs = []


def call(action, body=None, admin=False, inst='test', code=None):
    h = dict(BASE_H)
    if admin or code: h['X-Code-Organisation'] = code or CODE
    req = urllib.request.Request(f'{B}/api/soiree/{action}?instance={inst}', data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET', headers=h)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())


def verifie(nom, cond, info=''):
    print(('OK   ' if cond else 'ECHEC') + ' ' + nom + (f'  [{info}]' if not cond else ''))
    if not cond: echecs.append(nom)


def personne(**k):
    p = {'prenom': 'Jean', 'nom': 'Test', 'email': 'test.soiree@example.com', 'ville': 'Annecy', 'congregation': 'Église test', 'adultes': 2, 'enfants': 1}
    p.update(k); return p


# remise a zero de l'instance test
for i in call('liste', admin=True)[1].get('inscrits', []): call('annulation', {'id': i['id']}, admin=True)
s, d = call('etat'); verifie('etat public', s == 200 and d['pris'] == 0 and 'inscrits' not in d, d)
s, d = call('liste'); verifie('liste refusee sans code', s == 403, s)
s, d = call('liste', code='mauvais-code'); verifie('liste refusee avec mauvais code', s == 403, s)
s, d = call('reglages', {'capacite': 6}, admin=True); verifie('jauge a 6', s == 200 and d['capacite'] == 6, d)
s, d = call('reglages', {'capacite': 6}); verifie('jauge refusee au public', s == 403, s)

# validations
for nom, corps, attendu in [
    ('prenom vide', personne(prenom=''), 400), ('nom avec chiffres', personne(nom='Test2'), 400),
    ('email invalide', personne(email='pas-un-email'), 400), ('email absent (public)', personne(email=''), 400),
    ('ville vide', personne(ville=''), 400), ('0 adulte', personne(adultes=0), 400), ('11 enfants', personne(enfants=11), 400),
    ('adultes non entier', personne(adultes=1.5), 400), ('congregation avec lien', personne(congregation='voir https://x.ru'), 400),
    ('congregation trop longue', personne(congregation='x' * 90), 400)]:
    s, d = call('inscription', corps); verifie(f'refus : {nom}', s == attendu, (s, d))
s, d = call('inscription', {**personne(), 'site': 'robot'}); verifie('champ piege ignore', s == 200 and call('etat')[1]['pris'] == 0, (s, d))

# inscription publique + e-mail
s, d = call('inscription', personne(prenom='Élodie', nom="D'Arc-Martin"))
verifie('inscription publique 2+1', s == 201 and d['pris'] == 3 and d['restantes'] == 3 and len(d.get('cle', '')) == 32, d)
print('     e-mail envoye :', d.get('email_envoye'))
ins1 = d
s, d = call('inscription', personne(email='TEST.soiree+autre@example.com', prenom='Paul')); verifie('doublon e-mail refuse', s == 409 and 'existe déjà' in d['erreur'], d)
s, d = call('inscription', personne(email='b@example.com', adultes=3, enfants=1)); verifie('depassement refuse (4 > 3)', s == 409 and '3 places' in d['erreur'], d)
s, d = call('inscription', personne(email='c@example.com', adultes=2, enfants=1, congregation='')); verifie('remplit la jauge (3)', s == 201 and d['complet'], d)
s, d = call('inscription', personne(email='d@example.com', adultes=1, enfants=0)); verifie('complet refuse', s == 409 and 'complète' in d['erreur'], d)
s, d = call('inscription', personne(email='', adultes=1, enfants=0), admin=True); verifie('organisation sans forcer refusee', s == 409, d)
s, d = call('inscription', {**personne(email='', adultes=1, enfants=0, prenom='Ajout'), 'forcer': True}, admin=True)
verifie('organisation force, sans e-mail', s == 201 and d['pris'] == 7 and d['restantes'] == 0 and d['email_envoye'] is False, d)

# consultation et annulation par lien
s, d = call('consulter', {'id': ins1['id'], 'cle': '0' * 32}); verifie('consulter mauvaise cle', s == 403, d)
s, d = call('consulter', {'id': ins1['id'], 'cle': ins1['cle']}); verifie('consulter bonne cle', s == 200 and d['prenom'] == 'Élodie' and 'email' not in d, d)
s, d = call('annulation', {'id': ins1['id'], 'cle': ins1['cle'][:-1] + 'x'}); verifie('annulation mauvaise cle', s == 403, d)
s, d = call('annulation', {'id': ins1['id'], 'cle': ins1['cle']}); verifie('annulation par lien', s == 200 and d['pris'] == 4, d)
s, d = call('annulation', {'id': ins1['id'], 'cle': ins1['cle']}); verifie('double annulation = 404', s == 404, d)

# organisation
s, d = call('liste', admin=True); verifie('liste organisation', s == 200 and len(d['inscrits']) == 2 and d['journal'], d)
iid = d['inscrits'][0]['id']
s, d = call('arrivee', {'id': iid}, admin=True); verifie('arrivee', s == 200 and d['arrivee'], d)
s, d = call('arrivee', {'id': iid, 'annuler': True}, admin=True); verifie('arrivee annulee', s == 200 and d['arrivee'] is None, d)
s, d = call('arrivee', {'id': iid}); verifie('arrivee refusee au public', s == 403, d)
s, d = call('effacer-coordonnees', {}); verifie('effacement refuse au public', s == 403, d)
s, d = call('reglages', {'capacite': 0}, admin=True); verifie('jauge 0 refusee', s == 400, d)

# remise a zero
for i in call('liste', admin=True)[1]['inscrits']: call('annulation', {'id': i['id']}, admin=True)
call('reglages', {'capacite': 100}, admin=True)
s, d = call('etat'); verifie('test remis a zero', d['pris'] == 0 and d['capacite'] == 100, d)
s, d = call('etat', inst='live'); print('     live :', d)
print('\n' + ('TOUT EST OK' if not echecs else f'{len(echecs)} ECHEC(S) : {echecs}'))
sys.exit(1 if echecs else 0)
