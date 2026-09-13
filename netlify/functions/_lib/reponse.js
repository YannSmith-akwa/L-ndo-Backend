const ENTETES_BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': process.env.ORIGINE_AUTORISEE || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, corps) {
  return { statusCode, headers: ENTETES_BASE, body: JSON.stringify(corps) };
}

function erreur(statusCode, message) {
  return json(statusCode, { message });
}

// Réponse fichier téléchargeable (export CSV — voir admin-export.js).
// Le BOM UTF-8 (\uFEFF) en tête du corps n'est pas cosmétique : sans
// lui, Excel sous Windows ouvre un CSV UTF-8 contenant des accents en
// les affichant comme du charabia (il suppose Latin-1 par défaut faute
// d'indice explicite) — c'est le correctif standard, pas une
// bidouille propre à ce projet.
function fichier(nomFichier, contenu, typeMime = 'text/csv; charset=utf-8') {
  return {
    statusCode: 200,
    headers: {
      ...ENTETES_BASE,
      'Content-Type': typeMime,
      'Content-Disposition': `attachment; filename="${nomFichier}"`,
    },
    body: '\uFEFF' + contenu,
  };
}

// Répond immédiatement aux requêtes préliminaires CORS (OPTIONS) —
// à appeler en tout début de chaque handler.
function reponsePreliminaireCORS(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  return null;
}

module.exports = { json, erreur, fichier, reponsePreliminaireCORS };
