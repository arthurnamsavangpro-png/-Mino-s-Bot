# Checklist d'exécution de l'audit (pratique)

Date: 2026-03-19  
But: transformer l'audit en plan d'exécution concret, actionnable PR par PR.

## Mode d'emploi

- [ ] Avancer dans l'ordre P0 -> P1 -> P2.
- [ ] Ouvrir **1 PR par bloc** (éviter les PR énormes).
- [ ] Pour chaque PR: inclure "risque", "rollback", "tests".
- [ ] Ne passer à l'étape suivante que si les critères de validation sont verts.

---

## P0 — Fiabilité immédiate (à faire en premier)

### P0.1 Transactions PostgreSQL sûres (invitations)
- [ ] Créer un helper transactionnel (`withTransaction(pool, fn)`).
- [ ] Remplacer les `pool.query('BEGIN'/'COMMIT'/'ROLLBACK')` par client dédié.
- [ ] Corriger `handleGuildMemberAdd` et `handleGuildMemberRemove`.
- [ ] Ajouter logs d'erreur transactionnelle avec contexte (`guildId`, `memberId`).

**Validation P0.1**
- [ ] Test concurrent: 20 joins simulés -> totals cohérents.
- [ ] Test rollback: erreur forcée -> aucune écriture partielle.
- [ ] Vérifier qu'aucun `pool.query('BEGIN')` ne reste dans le repo.

### P0.2 Graceful shutdown
- [ ] Ajouter handlers `SIGINT` / `SIGTERM`.
- [ ] Stocker les timers (`setInterval`) pour pouvoir `clearInterval`.
- [ ] Fermer proprement `client.destroy()` et `pool.end()`.
- [ ] Ajouter timeout de sécurité (hard exit si shutdown bloqué).

**Validation P0.2**
- [ ] Arrêt manuel: pas d'erreur, process termine proprement.
- [ ] Redémarrage: pas de double scheduler actif.

---

## P1 — Stabilisation architecture/exploitation

### P1.1 Observabilité
- [ ] Introduire un logger structuré JSON.
- [ ] Standardiser les champs de log: `module`, `event`, `guildId`, `userId`, `requestId`.
- [ ] Logger la latence des commandes (début/fin).
- [ ] Ajouter compteur erreurs par module.

**Validation P1.1**
- [ ] Un incident test est traçable de bout en bout (1 requestId).
- [ ] Top 5 erreurs par module visibles dans les logs.

### P1.2 Bootstrap modulaire
- [ ] Créer `bootstrap/config.js`.
- [ ] Créer `bootstrap/db.js`.
- [ ] Créer `bootstrap/commands.js`.
- [ ] Créer `bootstrap/events.js`.
- [ ] Alléger `index.js` (orchestrateur simple).

**Validation P1.2**
- [ ] `index.js` réduit et lisible.
- [ ] Aucun comportement fonctionnel modifié (smoke test OK).

### P1.3 Migrations DB versionnées
- [ ] Choisir l'outil de migration.
- [ ] Initialiser `schema_migrations`.
- [ ] Extraire le SQL du runtime vers fichiers de migration.
- [ ] Documenter stratégie rollback.

**Validation P1.3**
- [ ] Base vide -> migration up complète OK.
- [ ] Base existante -> migration idempotente OK.
- [ ] Rollback d'une migration critique testé.

---

## P2 — Qualité continue

### P2.1 Tests automatisés
- [ ] Ajouter script `test` dans `package.json`.
- [ ] Écrire tests unitaires utils (parse/validation/permissions).
- [ ] Écrire tests d'intégration DB pour invitations/tickets/moderation.
- [ ] Activer tests en CI.

**Validation P2.1**
- [ ] Suite test passe en local + CI.
- [ ] Couverture minimale sur logique critique atteinte.

### P2.2 Refactor gros modules
- [ ] Découper `tickets.js` en sous-fichiers (commands/handlers/repository/ui).
- [ ] Découper `moderation.js` idem.
- [ ] Découper `automod.js` idem.
- [ ] Uniformiser conventions entre modules.

**Validation P2.2**
- [ ] Réduction de taille des fichiers principaux.
- [ ] Aucune régression fonctionnelle sur commandes majeures.

### P2.3 Intents Discord
- [ ] Cartographier quelles features utilisent quels intents.
- [ ] Désactiver intents non nécessaires.
- [ ] Documenter justification de chaque intent restant.

**Validation P2.3**
- [ ] Bot fonctionnel avec set d'intents réduit.
- [ ] Aucun event critique perdu.

---

## Checklist PR (à copier/coller à chaque PR)

- [ ] Objectif de la PR clair et limité.
- [ ] Risques identifiés.
- [ ] Plan de rollback défini.
- [ ] Logs/observabilité adaptés.
- [ ] Tests ajoutés/mis à jour.
- [ ] Notes d'exploitation mises à jour.

## Définition de "Done" globale

- [ ] Plus de transaction non atomique dans le code.
- [ ] Shutdown propre en prod validé.
- [ ] Logs structurés + métriques mini en place.
- [ ] Migrations DB versionnées actives.
- [ ] Pipeline de tests opérationnel.
- [ ] Modules critiques découpés.
