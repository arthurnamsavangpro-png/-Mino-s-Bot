# Audit expert — Système de bienvenue & onboarding

Date: 2026-03-17  
Périmètre: architecture bot Discord (`index.js`, modules existants) + nouveau module `welcome.js`

## Résumé exécutif

Tu as déjà une base solide (modération, automod, tickets, invitations, absence, updates).  
Le point manquant pour un onboarding premium était un **accueil structuré** des nouveaux membres.

J’ai donc mis en place un **système complet de bienvenue v1** et je propose ci-dessous une roadmap expert vers une v2/v3 enterprise.

## Ce qui a été livré (v1 opérationnelle)

### 1) Module dédié `welcome.js`

- Commande slash `/welcome` avec 4 sous-commandes:
  - `set`: active le système + choix salon + template
  - `info`: affiche l’état courant
  - `test`: envoie un aperçu
  - `disable`: désactive proprement
- Contrôle d’accès: permissions `ManageGuild` pour les actions sensibles.
- Message personnalisable avec variables:
  - `{user}` (mention)
  - `{username}`
  - `{server}`
  - `{member_count}`

### 2) Persistance SQL

Table `welcome_settings` ajoutée:
- `guild_id`
- `channel_id`
- `message_template`
- `enabled`
- `updated_at`

### 3) Intégration runtime

- Enregistrement automatique des commandes `/welcome` dans `index.js`.
- Hook événementiel `guildMemberAdd` branché pour poster la bienvenue en temps réel.
- Intégration dans `/help` pour que le staff découvre rapidement la fonctionnalité.

## Audit architecture (niveau expert)

## Forces

1. **Modularité propre**: chaque domaine reste isolé (`welcome`, `invitations`, `tickets`, etc.).
2. **Simplicité d’exploitation**: un serveur peut activer/désactiver sans redéploiement.
3. **Risque sécurité faible**: permissions staff explicites + envoi limité au salon configuré.

## Risques / limites actuelles

1. **Onboarding limité au message texte**
   - Pas encore de DM de bienvenue, pas de tunnel guidé, pas de checklist.
2. **Pas de segmentation**
   - Le message est identique pour tous (pas de variations selon source d’invite, rôle, langue).
3. **Pas de KPI onboarding**
   - Aucun suivi de conversion (présentation faite, ticket ouvert, premier message, rétention J+1/J+7).
4. **Pas de retry intelligent**
   - Si salon inaccessible/perms cassées, l’échec est silencieux (volontaire pour robustesse) mais non monitoré.

## Proposition “Système complet” (plan recommandé)

### Phase 1 — Foundation (immédiat)

- ✅ Déjà fait: accueil configurable + test + disable.
- À ajouter rapidement:
  - log staff des erreurs d’envoi bienvenue,
  - fallback salon secondaire,
  - template multi-lignes validé (anti-format cassé).

### Phase 2 — Onboarding intelligent

- DM automatisé en 3 étapes (T0 / T+10 min / T+24h).
- Boutons d’actions rapides:
  - “Lire le règlement”
  - “Se présenter”
  - “Créer un ticket support”.
- Attribution d’un rôle `newcomer` temporaire avec expiration.

### Phase 3 — Analytics & pilotage

- Dashboard stats onboarding:
  - joins/jour,
  - taux de présentation,
  - taux de rétention J+1/J+7,
  - conversion vers vouch/ticket.
- Alertes automatiques si baisse de conversion (>X%).

### Phase 4 — Personnalisation avancée

- Variantes de templates par:
  - langue,
  - type d’invite,
  - catégorie de communauté.
- A/B testing message de bienvenue.

## Template recommandé prêt à l’emploi

```txt
👋 Bienvenue {user} sur **{server}** !
Tu es notre **{member_count}e** membre.

✅ Étape 1 : Lis le règlement
✅ Étape 2 : Présente-toi dans le salon prévu
✅ Étape 3 : Besoin d’aide ? Ouvre un ticket

Bon séjour parmi nous 🚀
```

## Conclusion

Le bot passe désormais d’une logique “outil de gestion” à une logique “expérience membre” dès l’arrivée.
La v1 est solide et exploitable immédiatement. Pour un système **vraiment complet**, la priorité suivante est la **mesure KPI onboarding** + **séquences DM intelligentes**.
