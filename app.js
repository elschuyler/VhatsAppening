const db = new Dexie('VhatsAppeningDB');
db.version(1).stores({
    nodes: 'id, name, updatedAt',
    chats: 'id, agentId, role, timestamp' 
});

let activeAgentId = null;
let masterKey = null;

// --- CRYPTO (AES-GCM for API Keys) ---
async function initCrypto() {
    let keyData = localStorage.getItem('device_master_key');
    if (!keyData) {
        masterKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const exported = await crypto.subtle.exportKey("jwk", masterKey);
        localStorage.setItem('device_master_key', JSON.stringify(exported));
    } else {
        masterKey = await crypto.subtle.importKey("jwk", JSON.parse(keyData), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    }
}

async function encryptData(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const cipherText = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, masterKey, encoded);
    return { iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipherText)) };
}

async function decryptData(encryptedObj) {
    if (!encryptedObj || !encryptedObj.iv) return null;
    try {
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(encryptedObj.iv) }, masterKey, new Uint8Array(encryptedObj.cipher));
        return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
}

// --- BOOT UP ---
document.addEventListener('DOMContentLoaded', async () => {
    await initCrypto();
    await renderNodeList();
});

// --- NAVIGATION LOGIC ---
function switchView(viewId) {
    const main = document.getElementById('viewMain');
    const chat = document.getElementById('viewChat');
    
    // Explicit class toggling avoids weird display bug artifacts
    if (viewId === 'viewChat') {
        main.classList.add('hidden');
        chat.classList.remove('hidden');
    } else {
        chat.classList.add('hidden');
        main.classList.remove('hidden');
        activeAgentId = null;
    }
}

document.getElementById('btnBack').onclick = () => switchView('viewMain');

// --- NODE (AGENT) MANAGEMENT ---
document.getElementById('fabAddNode').onclick = () => {
    document.getElementById('formAddNode').reset();
    document.getElementById('formAddNode').dataset.editId = "";
    document.getElementById('modalAddNode').classList.remove('hidden');
};

document.getElementById('btnCancelNode').onclick = () => {
    document.getElementById('modalAddNode').classList.add('hidden');
};

document.getElementById('formAddNode').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.editId || crypto.randomUUID();
    
    const nodeData = {
        id,
        name: document.getElementById('nodeName').value.trim(),
        baseUrl: document.getElementById('nodeBaseUrl').value.trim().replace(/\/+$/, ""),
        model: document.getElementById('nodeModel').value.trim(),
        updatedAt: new Date().toISOString()
    };
    
    const key = document.getElementById('nodeApiKey').value.trim();
    if (key) {
        nodeData.encryptedKey = await encryptData(key);
    } else if (!f.dataset.editId) {
        return alert("API Key is required for new agents.");
    }

    await db.nodes.put(nodeData);
    document.getElementById('modalAddNode').classList.add('hidden');
    renderNodeList();
};

async function renderNodeList() {
    const list = document.getElementById('nodeList');
    list.innerHTML = '';
    const nodes = await db.nodes.orderBy('updatedAt').reverse().toArray();
    
    nodes.forEach(node => {
        const li = document.createElement('li');
        li.className = 'node-item';
        
        // Use an avatar letter
        const initial = node.name ? node.name.charAt(0).toUpperCase() : '?';
        
        li.innerHTML = `
            <div class="node-icon">${initial}</div>
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; position: relative;">
                <div class="node-name">${node.name}</div>
                <div class="node-preview">${node.model}</div>
            </div>
        `;
        
        li.onclick = (e) => {
            if (e.target.closest('.node-icon')) {
                // Edit mode
                const f = document.getElementById('formAddNode');
                f.dataset.editId = node.id;
                document.getElementById('nodeName').value = node.name;
                document.getElementById('nodeBaseUrl').value = node.baseUrl;
                document.getElementById('nodeModel').value = node.model;
                document.getElementById('nodeApiKey').value = ""; // Key is hidden!
                document.getElementById('modalAddNode').classList.remove('hidden');
            } else {
                openChat(node);
            }
        };
        list.appendChild(li);
    });
}

// --- CHAT ENGINE ---
const chatInput = document.getElementById('chatInput');

// Auto-resize textarea like WhatsApp
chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight < 120 ? this.scrollHeight : 120) + 'px';
});

async function openChat(node) {
    activeAgentId = node.id;
    document.getElementById('chatHeaderTitle').textContent = node.name;
    switchView('viewChat');
    
    // Ensure layout calculations are fresh when opening
    chatInput.style.height = 'auto';
    chatInput.value = '';
    
    await loadMessages();
}

async function loadMessages() {
    const list = document.getElementById('messageList');
    list.innerHTML = '';
    const msgs = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    msgs.forEach(m => renderBubble(m.content, m.role));
    scrollChat();
}

function renderBubble(text, role) {
    const div = document.createElement('div');
    div.className = `msg-bubble msg-${role}`;
    div.textContent = text;
    document.getElementById('messageList').appendChild(div);
    return div;
}

function scrollChat() {
    const container = document.getElementById('chatContainer');
    container.scrollTop = container.scrollHeight;
}

document.getElementById('btnSend').onclick = async () => {
    const text = chatInput.value.trim();
    if (!text || !activeAgentId) return;

    // Reset UI
    chatInput.value = '';
    chatInput.style.height = 'auto';
    renderBubble(text, 'user');
    scrollChat();

    // Setup request
    const agent = await db.nodes.get(activeAgentId);
    const apiKey = await decryptData(agent.encryptedKey);
    const history = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    const apiMsgs = [...history.map(m => ({role: m.role, content: m.content})), {role: 'user', content: text}];

    // Save user message locally
    await db.chats.add({id: crypto.randomUUID(), agentId: activeAgentId, role: 'user', content: text, timestamp: Date.now()});

    const aiBubble = renderBubble("...", 'ai');
    let fullText = "";

    try {
        const res = await fetch(`${agent.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: agent.model, messages: apiMsgs, stream: true })
        });

        if (!res.ok) throw new Error(`API Error: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        aiBubble.textContent = "";

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            
            decoder.decode(value).split('\n').forEach(line => {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const content = JSON.parse(line.slice(6)).choices[0].delta.content || "";
                        fullText += content;
                        aiBubble.textContent = fullText;
                        scrollChat();
                    } catch(e) { /* ignore fragment errors */ }
                }
            });
        }
        
        await db.chats.add({id: crypto.randomUUID(), agentId: activeAgentId, role: 'ai', content: fullText, timestamp: Date.now()});
    } catch(e) { 
        aiBubble.textContent = `[Connection Failed] ${e.message}`; 
    }
};
