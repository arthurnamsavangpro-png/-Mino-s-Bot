# Audit technique des modules du bot Discord

Date: 2026-03-19
Périmètre: `index.js` + modules fonctionnels (`tickets`, `moderation`, `automod`, `invitations`, `giveaway`, `vouches`, `rankup`, `modrank`, `welcome`, `updates`, `absence`, `serverstats`, `worl`, `help`, `send-message`).

## Résumé exécutif

Le bot est **fonctionnel et riche en features**, mais il atteint un niveau de complexité où la **fiabilité opérationnelle** et la **maintenabilité** deviennent les priorités.

### Score global (estimation audit)
- Architecture: **6/10**
- Fiabilité prod: **5/10**
- Sécurité / robustesse: **6/10**
- Observabilité: **4/10**
- Maintenabilité: **4/10**

## Forces actuelles

- Architecture par services/module factory (`createXService`) déjà en place.  
- Usage majoritaire de requêtes SQL paramétrées (`$1`, `$2`), bon point contre l'injection SQL.  
- Nombreuses protections en runtime (try/catch autour des événements Discord) pour éviter les crashes immédiats.

## Points critiques (P0)

### 1) Transactions PostgreSQL potentiellement non atomiques
Dans `invitations.js`, les transactions utilisent `pool.query('BEGIN')` / `COMMIT` / `ROLLBACK` sans client dédié. Avec un pool, des requêtes peuvent partir sur des connexions différentes.

**Risque**: incohérences de stats d'invites sous charge/concurrence.

**Action**:
- Remplacer par `const client = await pool.connect(); try { await client.query('BEGIN'); ... } finally { client.release(); }`.
- Centraliser un helper transactionnel partagé.

## Points prioritaires (P1)

### 2) Point d'entrée monolithique et couplage élevé
`index.js` concentre configuration env, bootstrap DB, enregistrement commandes, listeners et orchestration de tous les modules.

**Risque**: régressions à chaque changement, coût de review élevé.

**Action**:
- Extraire en couches: `bootstrap/config`, `bootstrap/db`, `bootstrap/commands`, `bootstrap/events`.
- Déclarer un routeur d'interactions (mapping commande -> handler) plutôt que le chaînage séquentiel de `if (await module.handleInteraction(...)) return;`.

### 3) Schéma DB géré inline au runtime (sans migrations versionnées)
Le schéma SQL est créé/modifié dans une énorme requête au démarrage.

**Risque**: évolution difficile, rollback complexe, traçabilité faible.

**Action**:
- Introduire un vrai système de migration (ex: `node-pg-migrate`, `knex`, ou migrations maison versionnées).
- Mettre en place une table `schema_migrations`.

### 4) Observabilité insuffisante
Logs uniquement `console.*`, pas de corrélation, pas de métriques (latence commandes, erreurs par module, DB slow queries).

**Risque**: diagnostic incident lent.

**Action**:
- Logger structuré (pino/winston JSON).
- Contextualiser chaque log avec `guildId`, `userId`, `module`, `requestId`.
- Ajouter métriques minimales (succès/erreurs par commande, durée p95).

### 5) Pas de stratégie de shutdown propre
Présence de plusieurs `setInterval` globaux, mais pas de gestion `SIGINT/SIGTERM` pour stopper schedulers, fermer le client Discord et `pool.end()`.

**Risque**: arrêt sale en prod, jobs interrompus, connexions pendantes.

**Action**:
- Implémenter un `gracefulShutdown()`.
- Stocker les timers pour les `clearInterval`.

## Axes d'amélioration (P2)

### 6) Intentions Discord très larges
Le client active des intents coûteux/sensibles (`GuildPresences`, `MessageContent`) globalement.

**Action**:
- Réduire aux intents strictement nécessaires par feature.
- Documenter pourquoi chaque intent est requis.

### 7) Dette de test
`package.json` n'expose qu'un script `start`; pas de tests automatisés.

**Action**:
- Ajouter tests unitaires sur utils critiques (parse, validation, permissions).
- Ajouter tests d'intégration DB pour modules à forte logique métier (`tickets`, `invitations`, `moderation`).

### 8) Modules très volumineux
Certains modules sont massifs (`tickets.js`, `moderation.js`, `automod.js`), ce qui ralentit maintenance et onboarding.

**Action**:
- Découper par sous-domaines (commands / handlers / repository / domain service / ui builders).
- Standardiser la structure inter-modules.

## Plan recommandé (30 / 60 / 90 jours)

### 0-30 jours
1. Corriger toutes transactions pool -> client dédié (priorité invitations).  
2. Ajouter graceful shutdown (Discord + DB + timers).  
3. Logger structuré + IDs de corrélation.

### 31-60 jours
1. Mettre en place migration DB versionnée.  
2. Introduire routeur d'interactions et bootstrap séparé.  
3. Ajouter premiers tests automatiques CI.

### 61-90 jours
1. Refactor gros modules (`tickets`, `moderation`, `automod`) en sous-composants.  
2. Réduction/justification des intents Discord.  
3. Dashboards d'exploitation (erreurs, latence, commandes top).

## KPI de succès

- Taux d'erreurs interactions < 0.5%.
- MTTR incident divisé par 2.
- Couverture tests > 40% sur logique métier critique.
- Temps moyen review PR réduit de 30%.

## Conclusion

Le projet est déjà avancé en fonctionnalités. Le meilleur ROI n'est pas d'ajouter encore des commandes, mais de **stabiliser l'infra logicielle**: transactions fiables, migrations, observabilité et découpage des gros modules.
