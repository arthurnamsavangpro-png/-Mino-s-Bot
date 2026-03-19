# Audit technique des modules — 2026-03-19

## 1) Périmètre et méthode

Audit réalisé sur l’architecture Node.js/Discord.js, les modules métier (`tickets`, `moderation`, `automod`, `invitations`, `giveaway`, etc.), la couche bootstrap, les utilitaires, et la stratégie de tests.

Méthode utilisée:
- lecture statique du code source,
- revue de la structure des modules,
- exécution de la suite de tests existante,
- identification des risques (maintenabilité, fiabilité, performance, observabilité, sécurité opérationnelle).

---

## 2) Constat global (résumé exécutif)

### Note globale
**6.8 / 10**

### Forces
- Base fonctionnelle riche et couvrant de nombreux besoins Discord (tickets, modération, automod, giveaways, invitations, etc.).
- Présence d’un bootstrap clair (`config`, `db`, `events`, `commands`).
- Journalisation structurée JSON déjà en place.
- Migration SQL versionnée + tests unitaires/intégration déjà présents.

### Faiblesses principales
1. **Modules monolithiques très volumineux** (jusqu’à ~3 500 lignes) qui ralentissent les évolutions.
2. **Erreurs parfois masquées** (`catch {}` ou `catch(() => {})`) ce qui réduit la fiabilité opérationnelle.
3. **Migrations partielles dans les modules runtime** (ALTER TABLE dans le code métier) au lieu d’un flux unique de migration.
4. **Couverture de tests insuffisante sur les parcours critiques** (interaction Discord, permissions, workflows longs).
5. **Validation de configuration trop permissive** (certains `Number(...)` non contrôlés contre `NaN`).

---

## 3) Détail par axe d’amélioration

## Axe A — Architecture & découpage des modules (**Priorité P1**)

### Observations
- `tickets.js` (~3488 lignes), `moderation.js` (~2667 lignes), `automod.js` (~2076 lignes) concentrent beaucoup de responsabilités.
- Le routing d’interactions appelle les services séquentiellement via une longue chaîne de `if (await service.handleInteraction(...)) return;`.

### Impacts
- Coût de maintenance élevé (on casse plus facilement des comportements existants).
- Review code plus difficile.
- Latence potentiellement plus élevée sur interactions (chaînage de nombreux handlers).

### Recommandations
1. Introduire une **architecture par feature slices**:
   - `tickets/commands/*`, `tickets/services/*`, `tickets/repositories/*`, `tickets/ui/*`.
2. Remplacer la chaîne de handlers par un **routeur explicite** (map commande -> handler).
3. Isoler la logique DB dans des repositories par module.

### KPI cible
- Aucun fichier métier > 800 lignes.
- Temps moyen de review PR réduit (objectif interne).

---

## Axe B — Fiabilité & gestion d’erreurs (**Priorité P1**)

### Observations
- Présence de `catch {}` silencieux sur des opérations DB de structure.
- Certains blocs de startup/refresh utilisent `.catch(() => {})` qui absorbent les incidents.

### Impacts
- Pannes silencieuses (incohérences en production non détectées rapidement).
- Débogage plus long.

### Recommandations
1. Interdire les catches silencieux via lint rule.
2. Remplacer par `logger.warn/error` contextualisé (module, guildId, operation, requestId).
3. Ajouter des classes d’erreurs métier (`ConfigError`, `PermissionError`, `ExternalApiError`).

### KPI cible
- 0 `catch` silencieux en code de production.
- 100% des erreurs critiques loggées avec contexte minimal.

---

## Axe C — Schéma DB & migrations (**Priorité P1**)

### Observations
- Certaines évolutions de schéma sont faites “à la volée” dans les modules (ex: `ALTER TABLE ... IF NOT EXISTS` dans `tickets`/`serverstats`).

### Impacts
- Dérive du schéma selon le chemin d’exécution.
- Difficulté à reproduire l’état exact de la base entre environnements.

### Recommandations
1. Centraliser **toute** évolution de schéma dans `migrations/*.sql`.
2. Garder le runtime “schema-agnostic” (pas d’ALTER TABLE métier).
3. Ajouter un check CI qui échoue si du DDL est détecté hors `migrations/`.

### KPI cible
- 100% DDL uniquement dans les migrations.

---

## Axe D — Qualité logicielle & tests (**Priorité P1**)

### Observations
- Les tests existants passent, mais ciblent surtout utilitaires + migration.
- Faible couverture sur workflows métier lourds (tickets, moderation, automod, invitations).

### Recommandations
1. Ajouter tests d’intégration par module (happy path + erreurs).
2. Introduire tests de non-régression sur interactions critiques:
   - création ticket,
   - claim/close,
   - actions de modération,
   - règles automod.
3. Mettre en place un seuil de couverture progressif (ex: 35% -> 50% -> 65%).

### KPI cible
- Couverture branches/fonctions des modules critiques > 60% à moyen terme.

---

## Axe E — Configuration & robustesse runtime (**Priorité P2**)

### Observations
- Paramètres numériques issus d’env (`Number(...)`) sans rejet explicite de `NaN`.

### Impacts
- Comportements inattendus (intervals/cooldowns invalides).

### Recommandations
1. Ajouter un validateur fort au bootstrap (`safeNumber`, bornes, fallback + logs).
2. Échouer explicitement au démarrage si variable critique invalide.
3. Documenter les bornes dans `README`/docs config.

---

## Axe F — Performance & scalabilité (**Priorité P2**)

### Observations
- Multiples boucles de refresh périodiques (presence, vouchboard, giveaway sweeper, serverstats scheduler).
- Pipeline d’interaction global séquentiel.

### Recommandations
1. Uniformiser les workers périodiques (jitter + backoff + métriques).
2. Instrumenter latence p50/p95 des interactions.
3. Router directement par `commandName`/`customId` pour éviter l’évaluation de handlers non concernés.

---

## Axe G — Observabilité & exploitation (**Priorité P2**)

### Recommandations
1. Définir un format de log minimal obligatoire (requestId, guildId, userId, action, outcome, latencyMs).
2. Ajouter compteurs métier (tickets ouverts, actions modération, erreurs par module).
3. Créer un “runbook” d’incident (bot down, DB down, permissions manquantes).

---

## 4) Plan d’action priorisé (30/60/90 jours)

### 0-30 jours
- [P1] Supprimer catches silencieux + logs contextualisés.
- [P1] Extraire routeur d’interactions et réduire la chaîne séquentielle.
- [P1] Démarrer refacto `tickets` (split initial).
- [P1] Ajouter 10-15 tests d’intégration sur cas critiques.

### 31-60 jours
- [P1] Migrer tout DDL runtime vers `migrations/`.
- [P2] Valider strictement la config env + documentation.
- [P2] Instrumenter métriques latence interactions.

### 61-90 jours
- [P1] Finaliser découpage `moderation` et `automod`.
- [P2] Introduire linting/quality gate complet (eslint + règle anti-catch silencieux).
- [P2] Stabiliser un seuil coverage CI.

---

## 5) Quick wins immédiats

1. Ajouter une règle lint “no-empty-catch”.
2. Remplacer chaque `catch {}` par `catch (err) { logger.warn(...) }`.
3. Ajouter des tests d’intégration ciblant au moins une commande par module majeur.
4. Créer un mini routeur `interaction.commandName -> handler`.

---

## Conclusion

Ton bot est déjà **fonctionnel et avancé** côté features. Le principal frein n’est pas “ce qu’il fait”, mais **comment il est structuré à grande échelle**.

Si tu appliques d’abord les axes **A/B/C/D**, tu vas gagner rapidement en:
- stabilité en production,
- vitesse d’évolution,
- confiance lors des releases.


---

## 6) Mesures chiffrées (audit reproductible)

Pour rendre l’audit vérifiable/rejouable, un script d’analyse statique a été ajouté:
- `scripts/audit-modules.js`
- sortie générée: `docs/audit/modules-metrics-2026-03-19.json`

### Snapshot (2026-03-19)
- Fichiers JS analysés (hors tests): **27**
- Risque **high**: **8** modules
- Risque **medium**: **4** modules
- Risque **low**: **15** modules

### Top modules à traiter en premier (impact/risque)
1. `tickets.js` — 3489 lignes, 5 empty catch, 50 swallow catch, 4 DDL runtime, 31 `pool.query`
2. `moderation.js` — 2668 lignes, 8 swallow catch, 18 `pool.query`
3. `automod.js` — 2077 lignes, 5 empty catch, 11 swallow catch
4. `giveaway.js` — 1019 lignes, 19 swallow catch, 1 scheduler
5. `invitations.js` — 856 lignes, 5 swallow catch, 18 `pool.query`
6. `serverstats.js` — 595 lignes, 3 DDL runtime, 1 scheduler

---

## 7) Backlog technique concret (prochain sprint)

### Sprint 1 (objectif: fiabilité prod)
- [ ] Remplacer les `catch {}`/`catch(() => {})` sur `tickets`, `automod`, `giveaway`, `moderation`, `invitations`.
- [ ] Introduire une helper `safeLogError(module, action, err, context)` pour uniformiser les logs.
- [ ] Ajouter 1 test d’intégration par module critique (tickets/moderation/automod/invitations).

### Sprint 2 (objectif: architecture)
- [ ] Extraire `tickets.js` en sous-modules (commands/service/repository/ui).
- [ ] Introduire un routeur d’interactions basé sur `commandName/customId` (plus de chaîne séquentielle globale).
- [ ] Sortir le DDL runtime de `tickets/serverstats` vers `migrations/*.sql`.

### Sprint 3 (objectif: gouvernance qualité)
- [ ] Ajouter `eslint` + règle anti-empty-catch.
- [ ] Ajouter script CI: échec si `ALTER TABLE` trouvé hors `migrations/`.
- [ ] Ajouter seuil coverage progressif (ex: 35% puis 50%).
