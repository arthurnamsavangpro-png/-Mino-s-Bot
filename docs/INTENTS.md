# Cartographie des intents Discord

## Intents actifs par défaut

- `Guilds` : slash commands, interactions, gestion globale du serveur.
- `GuildMembers` : onboarding, invitations, rôles, modération membres.
- `GuildMessages` : automod sur messages, tickets/modération via messages.
- `GuildPresences` : stats online + détection présence/bio côté modération.
- `MessageContent` : analyse de contenu (automod mots/liens/spam).

## Réduction possible

Les intents sensibles peuvent être désactivés par environnement:

- `ENABLE_GUILD_PRESENCES=false`
- `ENABLE_MESSAGE_CONTENT=false`

⚠️ Désactiver ces intents coupe les features dépendantes (automod contenu, stats présence, règles présence/bio).

## Justification

- On garde le minimum requis pour les fonctionnalités actuelles.
- Les intents optionnels sont maintenant pilotables, afin de réduire la surface d'accès selon le besoin d'exploitation.
