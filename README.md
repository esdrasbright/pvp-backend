# Wuthering Waves PvP Draft - Serveur

Serveur Node.js avec Socket.IO pour le mode multijoueur temps reel.

## Configuration Discord OAuth2

1. Aller sur https://discord.com/developers/applications
2. Creer une nouvelle application
3. Dans OAuth2 > General:
   - Copier le **Client ID**
   - Generer et copier le **Client Secret**
4. Dans OAuth2 > Redirects:
   - Ajouter `http://localhost:3001/auth/discord/callback`

## Installation

```bash
cd server
npm install
```

## Configuration

Creer un fichier `.env` dans le dossier `server/`:

```env
PORT=3001
CLIENT_URL=http://localhost:3000

DISCORD_CLIENT_ID=votre_client_id
DISCORD_CLIENT_SECRET=votre_client_secret
DISCORD_REDIRECT_URI=http://localhost:3001/auth/discord/callback

SESSION_SECRET=une_chaine_secrete_aleatoire
```

## Lancement

```bash
# En developpement (avec auto-reload)
npm run dev

# En production
npm start
```

## Lancement du projet complet

Terminal 1 - Serveur:
```bash
cd server
npm install
npm run dev
```

Terminal 2 - Client Next.js:
```bash
npm run dev
```

## Variables d'environnement Client

Creer un fichier `.env.local` a la racine du projet:

```env
NEXT_PUBLIC_SERVER_URL=http://localhost:3001
```

## Fonctionnalites

### Authentification
- `GET auth/discord` - Redirection vers Discord OAuth
- `GET auth/discord/callback` - Callback OAuth
- `GET auth/me` - Verifier la session
- `POST auth/logout` - Deconnexion

### API REST
- `GET /api/box/:discordId` - Recuperer la box d'un joueur

### Socket.IO Events

**Client -> Serveur:**
- `auth:login` - Authentifier le socket avec les infos Discord
- `box:save` - Sauvegarder sa box
- `room:join` - Rejoindre un slot (player1 ou player2)
- `room:leave` - Quitter son slot
- `config:update` - Modifier la configuration
- `draft:start` - Demarrer la draft
- `draft:ban` - Bannir un personnage
- `draft:pick` - Choisir un personnage
- `draft:reset` - Reinitialiser la draft

**Serveur -> Client:**
- `box:loaded` - Box chargee
- `box:saved` - Box sauvegardee
- `room:state` - Etat complet de la room
- `room:updated` - Room mise a jour
- `config:updated` - Config mise a jour
- `draft:started` - Draft demarree
- `draft:updated` - Draft mise a jour
- `draft:reset` - Draft reinitialisee
- `error` - Erreur

## Stockage

Les box des joueurs sont stockees dans `server/data/boxes.json`.
Ce fichier est cree automatiquement au premier lancement.
