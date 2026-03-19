# Stratégie de migrations DB

## Principe

- Les migrations SQL vivent dans `migrations/*.sql`.
- Elles sont appliquées dans l'ordre alphabétique.
- La table `schema_migrations` enregistre chaque fichier exécuté.
- Chaque migration s'exécute dans une transaction dédiée.

## Rollback

- En cas d'échec pendant l'exécution d'une migration, la transaction est rollback automatiquement.
- En cas de bug post-déploiement:
  1. stopper le bot,
  2. restaurer la sauvegarde DB,
  3. déployer la version précédente,
  4. préparer une migration corrective (`NNN_fix_*.sql`).

## Règles

- Une migration appliquée ne doit pas être modifiée: créer un nouveau fichier.
- Favoriser des migrations idempotentes (`IF EXISTS`, `IF NOT EXISTS`) quand possible.
