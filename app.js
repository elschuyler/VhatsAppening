const db = new Dexie('VhatsAppeningDB');
db.version(1).stores({
    nodes: 'id, name, updatedAt',
    chats: 'id, agentId, role, timestamp' 
});

let activeAgentId = null;
let masterKey = null;

// --- CRYPTO ENGINE ---
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
    if (!encryptedObj || !encryptedObj.iv || !encryptedObj.cipher) return null;
    try {
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(encryptedObj.iv) }, masterKey, new Uint8Array(encryptedObj.cipher));
        return new TextDecoder().decode(decrypted);
    } catch(e) { return null; }
}

// --- UI LOGIC ---
document.addEventListener('DOMContentLoaded', async () => {
    await initCrypto();
    await renderNodeList();
});

const formAddNode = document.getElementById('formAddNode');
const nodeList = document.getElementById('nodeList');

document.getElementById('fabAddNode').onclick = () => {
    formAddNode.reset();
    formAddNode.dataset.editId = "";
    document.getElementById('modalAddNode').classList.remove('hidden');
};

document.getElementById('btnCancelNode').onclick = () => document.getElementById('modalAddNode').classList.add('hidden');

formAddNode.onsubmit = async (e) => {
    e.preventDefault();
    const id = formAddNode.dataset.editId || crypto.randomUUID();
    const name = document.getElementById('nodeName').value.trim();
    const baseUrl = document.getElementById('nodeBaseUrl').value.trim().replace(/\/+$/, "");
    const model = document.getElementById('nodeModel').value.trim();
    const apiKeyRaw = document.getElementById('nodeApiKey').value.trim();

    let nodeData = { id, name, baseUrl, model, updatedAt: new Date().toISOString() };
    if (apiKeyRaw) nodeData.encryptedKey = await encryptData(apiKeyRaw);

    if (formAddNode.dataset.editId) {
        await db.nodes.update(id, nodeData);
    } else {
        if (!apiKeyRaw) return alert("API Key required for new agents.");
        await db.nodes.add(nodeData);
    }

    document.getElementById('modalAddNode').classList.add('hidden');
    renderNodeList();
};

async function renderNodeList() {
    nodeList.innerHTML = '';
    const nodes = await db.nodes.orderBy('updatedAt').reverse().toArray();
    nodes.forEach(node => {
        const li = document.createElement('li');
        li.className = 'node-item';
        li.innerHTML = `
            <div class="node-icon">${node.name.charAt(0)}</div>
            <div class="node-info">
                <div class="node-name">${node.name}</div>
                <div class="node-preview">${node.model} • ${new URL(node.baseUrl).hostname}</div>
            </div>
        `;
        li.onclick = (e) => {
            if(e.target.closest('.node-icon')) {
                formAddNode.dataset.editId = node.id;
                document.getElementById('nodeName').value = node.name;
                document.getElementById('nodeBaseUrl').value = node.baseUrl;
                document.getElementById('nodeModel').value = node.model;
                document.getElementById('nodeApiKey').value = ""; 
                document.getElementById('modalAddNode').classList.remove('hidden');
            } else {
                openChat(node);
            }
        };
        nodeList.appendChild(li);
    });
}

// --- CHAT ENGINE ---
async function openChat(node) {
    activeAgentId = node.id;
    document.getElementById('chatHeaderTitle').textContent = node.name;
    document.getElementById('viewMain').classList.replace('view-active', 'view-hidden');
    document.getElementById('viewChat').classList.replace('view-hidden', 'view-active');
    await loadHistory();
}

document.getElementById('btnBack').onclick = () => {
    document.getElementById('viewChat').classList.replace('view-active', 'view-hidden');
    document.getElementById('viewMain').classList.replace('view-hidden', 'view-active');
};

async function loadHistory() {
    const list = document.getElementById('messageList');
    list.innerHTML = '';
    const history = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    history.forEach(m => renderBubble(m.content, m.role));
    scrollDown();
}

function renderBubble(text, role) {
    const div = document.createElement('div');
    div.className = `msg-bubble ${role === 'user' ? 'msg-user' : 'msg-ai'}`;
    div.textContent = text;
    document.getElementById('messageList').appendChild(div);
    return div;
}

function scrollDown() {
    const c = document.getElementById('chatContainer');
    c.scrollTop = c.scrollHeight;
}

document.getElementById('btnSend').onclick = async () => {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || !activeAgentId) return;

    input.value = '';
    renderBubble(text, 'user');
    scrollDown();

    const agent = await db.nodes.get(activeAgentId);
    const apiKey = await decryptData(agent.encryptedKey);
    const history = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    const apiMsgs = [...history.map(m => ({role: m.role, content: m.content})), {role: 'user', content: text}];

    await db.chats.add({id: crypto.randomUUID(), agentId: activeAgentId, role: 'user', content: text, timestamp: Date.now()});

    const aiBubble = renderBubble("...", 'ai');
    let fullAiText = "";

    try {
        const res = await fetch(`${agent.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: agent.model, messages: apiMsgs, stream: true })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        aiBubble.textContent = "";

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            chunk.split('\n').forEach(line => {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const content = JSON.parse(line.slice(6)).choices[0].delta.content || "";
                        fullAiText += content;
                        aiBubble.textContent = fullAiText;
                        scrollDown();
                    } catch(e){}
                }
            });
        }
        await db.chats.add({id: crypto.randomUUID(), agentId: activeAgentId, role: 'ai', content: fullAiText, timestamp: Date.now()});
    } catch(e) { aiBubble.textContent = "Error: " + e.message; }
};
