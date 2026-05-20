// ==UserScript==
// @name         ADblock plus pro max ;)
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  .
// @author       You
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =============================
    // === CONFIGURATION GLOBALE ===
    // =============================
    // 1) API Gemini
    const GEMINI_API_KEY = "aaaaaaaaaaaaaaaaaa";
    const MODEL = "gemini-3.5-flash"; // Modèle corrigé de "2.5-flash" qui n'existe pas

    // 2) Apparence de l’injection
    const opacityLevel = 0.03; // 0 (invisible) -> 1 (opaque)

    // 3) Divers
    const ICON_SELECTOR = ".fa-question-circle, .fas.fa-question-circle"; // tolérant
    const LOG_TAG = "[QCM-Gemini-Inject]";

    // <<< AJOUTÉ : Variables pour la gestion du quota
    let isRateLimited = false;
    let rateLimitTimeoutId = null;

    // ===========================
    // === OUTILS & NETTOYAGE ===
    // ===========================
    const cleanText = (txt) => txt ? txt.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim() : '';
    function normalizeText(txt) { return txt ? txt.replace(/\s+/g, ' ').trim().toLowerCase() : ''; }
    function parseQuestionNumberFromH4(h4) {
        const raw = h4 ? (h4.innerText || h4.textContent || "") : "";
        const m = raw.match(/question\s+(\d+)/i);
        return m ? m[1] : null; // string of digits
    }
    // Cherche le texte d’intro le plus proche AVANT le bloc question
    function getNearestIntro(questionEl) {
        let current = questionEl ? questionEl.previousElementSibling : null;
        while (current) {
            if ( current.matches('.textIntroPool.quest.intro') && current.querySelector('.textpool, .theia-text-block') ) {
                return cleanText( current.querySelector('.textpool, .theia-text-block')?.innerText );
            }
            current = current.previousElementSibling;
        }
        return null;
    }

    // ===========================
    // === EXTRACTION QCM-DEBUG ==
    // ===========================
    function extractQuestionData(icon) {
        const result = { qNumberLabel: "(numéro inconnu)", qNumber: null, qType: "(type inconnu)", introText: null, questionText: "(texte de question introuvable)", options: [], imgUrl: "(aucune image)" };
        try {
            const panel = icon.closest('.panel');
            if (!panel) return result;
            // Conteneur question (souvent .quest)
            const questionEl = panel.closest('.quest');
            const introText = getNearestIntro(questionEl);
            const h4 = panel.querySelector('h4.h4');
            const qType = h4?.querySelector('.pull-right span')?.textContent?.trim() || "(type inconnu)";
            const qNumber = parseQuestionNumberFromH4(h4);
            const qNumberLabel = qNumber ? `Question ${qNumber}` : "(numéro inconnu)";
            const questionText = cleanText(panel.querySelector('.theia-text-block p')?.textContent) || "(texte de question introuvable)";

            // === DÉBUT DE LA MODIFICATION ===
            const options = [];
            // 1. On essaie d'abord la nouvelle méthode pour trouver les options
            panel.querySelectorAll('.list-group-item').forEach((item) => {
                const letterElement = item.querySelector('.quest-letter');
                const textElement = item.querySelector('.propLabel .theia-text-block p');
                if (letterElement && textElement) {
                    const letter = cleanText(letterElement.textContent).replace('-', '').trim();
                    const text = cleanText(textElement.textContent);
                    if (letter && text) {
                        options.push(`${letter} — ${text}`);
                    }
                }
            });
            // 2. Si la nouvelle méthode n'a rien trouvé, on essaie l'ancienne méthode pour la compatibilité
            if (options.length === 0) {
                panel.querySelectorAll('tbody tr').forEach((tr) => {
                    const letter = cleanText(tr.querySelector('td.text-center')?.textContent);
                    const answer = cleanText(tr.querySelector('td:last-child p')?.textContent);
                    if (letter && answer) options.push(`${letter} — ${answer}`);
                });
            }
            // === FIN DE LA MODIFICATION ===

            const img = panel.querySelector('img');
            const imgUrl = img ? img.src : '(aucune image)';

            result.qNumber = qNumber; result.qNumberLabel = qNumberLabel; result.qType = qType;
            result.introText = introText; result.questionText = questionText; result.options = options; result.imgUrl = imgUrl;
            return result;
        } catch (err) { console.error(`${LOG_TAG} Erreur extractQuestionData :`, err); return result; }
    }
    function logQcmDebugBlock(data) {
        console.groupCollapsed(`${LOG_TAG} [QCM-Debug] ${data.qNumberLabel} (${data.qType})`);
        if (data.introText) console.log('📜 Contexte détecté :', data.introText.substring(0, 600) + '...');
        console.log('❓ Texte de la question :', data.questionText);
        console.log('🧾 Options :', data.options.length ? data.options : '(aucune trouvée)');
        console.log('🖼️ Image URL :', data.imgUrl);
        console.log('📝 Instruction incluse :', 'Répondre uniquement par la meilleure proposition (lettre ou texte).');
        console.groupEnd();
    }

    // ===========================
    // === APPEL API GEMINI ======
    // ===========================
    async function askGeminiWithQcmPayload(data) {
        // <<< CORRIGÉ : Template literals corrects
        const prompt = `Contexte (si présent): ${data.introText || "(aucun)"} Question: ${data.questionText} Options: ${data.options.map((o, i) => `- ${o}`).join('\n') || "(aucune)"} Image: \${data.imgUrl} Consigne: Répondre uniquement par la ou les bonne reponse entre les proposition (lettre a b c d ou si cets une valeur donne uniquement la valeur sans explicaion sans dire "Les réponses correctes sont : " juste les ou la letre ou la valeur rien de plus )., sans phrase complémentaire.`;
        console.log(`\${LOG_TAG} [Gemini Debug] Contenu envoyé :`, prompt);
        try {
            const response = await fetch( `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], }), } );
            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 429) {
                    let retryAfterSeconds = 60;
                    try {
                        const errorData = JSON.parse(errText);
                        const retryDelay = errorData?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
                        if (retryDelay) {
                            const match = retryDelay.match(/(\d+)s/);
                            if (match) {
                                retryAfterSeconds = parseInt(match[1], 10);
                            }
                        }
                    } catch (e) { /* Ignorer les erreurs de parsing */ }
                    handleRateLimit(retryAfterSeconds);
                    throw new Error(`Erreur API 429 : Quota épuisé. Veuillez réessayer dans ${retryAfterSeconds} secondes.`);
                }
                // <<< CORRIGÉ : Template literal correct
                throw new Error(`Erreur API ${response.status} : ${errText}`);
            }
            const dataJson = await response.json();
            const reply = dataJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Aucune réponse reçue.";
            return reply;
        } catch (error) {
            console.error(`${LOG_TAG} Erreur API Gemini :`, error);
            return `Erreur : \${error.message}`;
        }
    }

    // <<< AJOUTÉ : Fonction pour gérer le blocage temporaire suite à une erreur 429
    function handleRateLimit(retryAfterSeconds) {
        if (isRateLimited) return; // Déjà en attente

        isRateLimited = true;
        console.warn(`${LOG_TAG} ⚠️ Limite de quota Gemini atteinte. Désactivation des clics pour ${retryAfterSeconds} secondes.`);

        // Désactiver toutes les icônes
        const icons = document.querySelectorAll(ICON_SELECTOR);
        icons.forEach(icon => {
            icon.style.opacity = "0.5";
            icon.style.cursor = "not-allowed";
            icon.title = `Veuillez attendre ${retryAfterSeconds}s...`;
        });

        // Réactiver après le délai
        rateLimitTimeoutId = setTimeout(() => {
            console.log(`${LOG_TAG} ✅ Réactivation des clics.`);
            isRateLimited = false;
            bindIcons(); // Relie les événements pour restaurer le style
        }, retryAfterSeconds * 1000);
    }

    // =================================================
    // === INJECTION DISCRÈTE À CÔTÉ DE "Question N" ===
    // =================================================
    function injectHiddenValueForQuestion(questionNum, valueText) {
        // <<< CORRIGÉ : Nettoie le texte pour en faire un sélecteur CSS valide
        const safeSelector = valueText.replace(/[^^a-zA-Z0-9_-]/g, '');

        // Recherche tous les h4 susceptibles de contenir "Question N"
        const headers = document.querySelectorAll('h4.h4, .panel-heading h4');
        let injected = false;
        for (const h4 of headers) {
            const text = normalizeText(h4.innerText || h4.textContent || "");
            if (text.includes(`question ${String(questionNum)}`)) {
                // <<< CORRIGÉ : Utilise le sélecteur nettoyé pour éviter les erreurs
                if (h4.querySelector(`[data-answer="${safeSelector}"]`)) {
                    injected = true;
                    break;
                }
                // Span semi-transparent
                const span = document.createElement('span');
                span.textContent = ` ${valueText}`; // Affiche le texte original, non nettoyé
                span.style.setProperty('color', `rgba(0, 0, 0, ${opacityLevel})`, 'important');
                span.style.display = 'inline';
                span.style.marginLeft = '6px';
                span.style.fontSize = '0.9em';
                //span.style.color = '#000';
                span.style.verticalAlign = 'baseline';
                span.style.pointerEvents = 'none';
                span.style.transition = 'opacity 0.3s ease';
                // <<< CORRIGÉ : Stocke le sélecteur nettoyé dans l'attribut
                span.dataset.answer = safeSelector;
                // Insertion juste après le texte "Question N"
                const marker = [...h4.childNodes].find( n => n.nodeType === Node.TEXT_NODE && normalizeText(n.textContent).includes(`question ${String(questionNum)}`) );
                if (marker) {
                    marker.parentNode.insertBefore(span, marker.nextSibling);
                } else {
                    h4.appendChild(span);
                }
                console.log(`${LOG_TAG} [Inject] ✅ "${valueText}" ajouté à côté de Question ${questionNum}`);
                injected = true;
                break;
            }
        }
        if (!injected) {
            console.warn(`${LOG_TAG} [Inject] ⚠️ Question ${questionNum} non trouvée (DOM partiel).`);
        }
    }

    // ============================================
    // === STYLE CURSEUR + HOVER SUR L’ICÔNE ==== // ============================================
    const style = document.createElement("style");
    style.textContent = `
        ${ICON_SELECTOR} { cursor: pointer !important; transition: transform 0.2s ease, opacity 0.2s ease !important; }
        ${ICON_SELECTOR}:hover { transform: scale(1.15); opacity: 0.8; }
        [data-answer] { color: rgba(0, 0, 0, 0.03) !important; }
        @media (prefers-color-scheme: dark) {
            [data-answer] { color: rgba(255, 255, 255, 0.03) !important; }
        }
        [data-answer]::selection { background: #0078d7 !important; color: white !important; }
    `;
    document.head.appendChild(style);

    // ===========================
    // === BIND SUR LES ICÔNES ===
    // ===========================
    function onIconHover(e) {
        const icon = e.target.closest(ICON_SELECTOR);
        if (icon) {
            icon.style.setProperty("cursor", "pointer", "important");
            console.log(`${LOG_TAG} Survol d’une icône de question.`);
        }
    }

    async function onIconClick(e) {
        const icon = e.target.closest(ICON_SELECTOR);
        if (!icon) return;

        // <<< AJOUTÉ: Ignore le clic si on est en attente à cause d'un rate limit
        if (isRateLimited) {
            console.warn(`${LOG_TAG} Clic ignoré, en attente de la fin du rate limit.`);
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        // 1) Extraction QCM-Debug
        const data = extractQuestionData(icon);
        logQcmDebugBlock(data);

        // 2) UI attente
        const prevOpacity = icon.style.opacity;
        const prevCursor = icon.style.cursor;
        const prevTitle = icon.title;
        icon.style.opacity = "0.5";
        icon.style.cursor = "wait";
        icon.title = "Traitement en cours...";

        // 3) Appel Gemini
        const geminiReply = await askGeminiWithQcmPayload(data);
        console.log(`${LOG_TAG} Réponse brute Gemini :`, geminiReply);

        // 4) Injection discrète à côté de "Question N"
        if (data.qNumber && geminiReply && !geminiReply.startsWith("Erreur :")) {
            injectHiddenValueForQuestion(data.qNumber, geminiReply);
            console.log(`${LOG_TAG} ✅ Injection terminée pour ${data.qNumberLabel} → "${geminiReply}"`);
        } else {
            console.warn(`${LOG_TAG} ⚠️ Injection annulée pour ${data.qNumberLabel}. Réponse de Gemini invalide ou erreur API : "${geminiReply}"`);
        }

        // 5) Restaure l’UI de l’icône
        icon.style.opacity = prevOpacity || "1";
        icon.style.cursor = prevCursor || "pointer";
        icon.title = prevTitle || "Clique pour interroger";
    }

    function bindIcons() {
        document.querySelectorAll(ICON_SELECTOR).forEach((icon) => {
            // <<< MODIFIÉ: Met à jour l'état visuel en fonction du rate limit
            if (!isRateLimited) {
                icon.style.cursor = 'pointer';
                icon.title = "Clique pour interroger";
            } else {
                icon.style.cursor = 'not-allowed';
                icon.title = "Veuillez patienter...";
            }
        });
    }

    // ===========================
    // === OBSERVATEURS / INIT ===
    // ===========================
    // Mouseover global (affiche info console + force curseur)
    document.addEventListener("mouseover", onIconHover, { passive: true });

    // Click global (gère le clic sur l'icône)
    document.addEventListener("click", onIconClick, { passive: false });

    // Observe le DOM pour détecter les nouvelles questions
    const observer = new MutationObserver(() => bindIcons());
    observer.observe(document.body, { childList: true, subtree: true });

    // Init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindIcons, { once: true });
    } else {
        bindIcons();
    }

    console.info(`${LOG_TAG} Prêt : clique sur une icône ronde pour extraire la question, envoyer à Gemini, puis injecter la réponse à côté du titre.`);

})();