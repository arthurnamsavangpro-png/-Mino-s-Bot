# Audit expert — module Invitations

Date: 2026-03-17  
Périmètre: `invitations.js` + schéma SQL dans `index.js`

## Résumé exécutif

Le module invitations est **globalement propre et lisible** (requêtes paramétrées, permissions admin sur actions sensibles, séparation logique claire).  
En revanche, il présente plusieurs **risques fonctionnels et d’intégrité des données**:

1. **Incohérence des rôles rewards**: le système ajoute des rôles, mais ne les retire jamais si le score baisse.  
2. **Départ membre incomplet**: sur `guildMemberRemove`, le total est recalculé mais les rewards ne sont pas resynchronisées.  
3. **Course critique sur détection d’invite**: méthode delta cache (`uses`) fragile en cas d’arrivées quasi simultanées.  
4. **Absence de transaction DB** sur les écritures multi-étapes (join/leave), ce qui peut laisser des états partiellement appliqués.  
5. **Scalabilité limitée**: sous-commande `sync` séquentielle et potentiellement longue sur grosses guildes.

## Forces observées

- Contrôle d’accès admin cohérent pour `setlog`, `clearlog`, `setfakemin`, `setreward`, `delreward`, `bonus`, `sync`.  
- Utilisation de placeholders SQL (`$1`, `$2`, …), réduisant fortement le risque d’injection SQL.  
- Modélisation SQL simple et raisonnable (`invite_settings`, `invite_stats`, `invite_joins`, `invite_rewards`) avec index utiles sur les lectures principales.

## Constats détaillés

### 1) Rewards non réversibles (Critique fonctionnelle)

- La routine `syncRewardsForMember` ne fait qu’**ajouter** des rôles si seuil atteint.
- Elle ne retire jamais les rôles lorsque `total` redescend (départs, bonus négatif, correction admin).
- Impact: droits/rangs potentiellement conservés indûment, dette de modération manuelle.

### 2) Leave sans resync rewards (Élevé)

- Dans `handleGuildMemberRemove`, `left_count` et `total` sont mis à jour.
- Mais il n’y a pas d’appel à `syncRewardsForMember` après recalcul.
- Résultat: même si l’algorithme de retrait existait demain, cet événement ne déclencherait pas la mise à jour.

### 3) Détection d’invite fragile sous concurrence (Élevé)

- `resolveJoinInvite` identifie l’invite utilisée en comparant les usages entre cache et état actuel.
- Si plusieurs membres rejoignent quasi simultanément, l’attribution peut être imprécise (premier code dont `uses` a augmenté).
- Ce comportement est connu côté Discord et nécessite une stratégie de robustesse (file d’événements, horodatage rapproché, fallback explicite).

### 4) Intégrité DB sans transaction (Moyen)

- Les opérations de join/leave enchaînent plusieurs requêtes (insert join, update stats, recompute total, etc.) sans transaction.
- En cas d’échec intermédiaire (timeout DB, crash, rate limit Discord suivi d’exception non prévue), l’état peut devenir partiellement incohérent.

### 5) Gestion du cache invitations (Moyen)

- Le cache est bien initialisé (`primeCache`) et maintenu sur `inviteCreate`/`inviteDelete`.
- Mais il reste sensible aux redémarrages, permissions manquantes sur `guild.invites.fetch()`, et manques transitoires API.
- Dans ces cas, une partie des joins part en “invitation inconnue”, avec perte analytique.

### 6) Performance `sync` (Moyen)

- La sous-commande admin `sync` traite chaque utilisateur séquentiellement (`for ... await`), combinant recalcul SQL et appel Discord.
- Sur volumétrie élevée, risque de commande lente, timeout d’interaction, et back-pressure API Discord.

### 7) Durcissements mineurs (Faible)

- Pas de validation métier explicite “inviteur = invité” (cas rares mais à ignorer systématiquement).
- `total` est clampé à 0 (`GREATEST(0, ...)`) : c’est pratique UX, mais masque l’ampleur d’un malus net (si souhait d’audit strict, conserver une métrique brute).

## Recommandations priorisées

### Priorité P0 (immédiat)

1. **Rendre `syncRewardsForMember` bidirectionnel**:
   - Ajouter les rôles éligibles.
   - Retirer les rôles devenus inéligibles.
2. **Appeler la sync rewards** après tout recalcul significatif, notamment dans `handleGuildMemberRemove`.

### Priorité P1 (court terme)

3. **Encapsuler join/leave dans des transactions** SQL (`BEGIN/COMMIT/ROLLBACK`) pour garantir l’atomicité des compteurs.
4. **Améliorer la robustesse de résolution d’invite**:
   - journaliser explicitement les cas ambigus,
   - marquer un statut “unknown_ambiguous” pour audit,
   - envisager un mode de réconciliation périodique.

### Priorité P2 (moyen terme)

5. **Optimiser la commande `sync`**:
   - batch SQL,
   - limitation de concurrence sur appels Discord,
   - feedback progressif.
6. **Observabilité**:
   - métriques (`joins_total`, `joins_unknown`, `reward_add`, `reward_remove`, `sync_duration_ms`),
   - alertes si ratio “invitation inconnue” dépasse un seuil.

## Verdict

Le module est **bien structuré** et opérationnel, mais il nécessite des corrections ciblées pour atteindre un niveau production robuste sur le long terme (exactitude des rewards, cohérence transactionnelle, résilience à la concurrence Discord).
