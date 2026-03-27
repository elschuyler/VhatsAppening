// --- DATABASE INITIALIZATION ---
const db = new Dexie('VhatsAppeningDB');
db.version(1).stores({
    nodes: 'id, name, provider, updatedAt',
    chats: 'id, agentId, role, content, timestamp' 
});

// --- STATE ---
let activeAgentId = null;
let masterKey = null;

// --- DOM ELEMENTS ---
const viewMain = document.getElementById('viewMain');
const viewChat = document.getElementById('viewChat');
const nodeList = document.getElementById('nodeList');
const fabAddNode = document.getElementById('fabAddNode');
const modalAddNode = document.getElementById('modalAddNode');
const formAddNode = document.getElementById('formAddNode');
const btnCancelNode = document.getElementById('btnCancelNode');

const btnBack = document.getElementById('btnBack');
const chatHeaderTitle = document.getElementById('chatHeaderTitle');
const messageList = document.getElementById('messageList');
const chatInput = document.getElementById('chatInput');
const btnSend = document.getElementById('btnSend');
const chatContainer = document.getElementById('chatContainer');

// --- CRYPTO ENGINE (Transparent Device Encryption) ---
async function initCrypto() {
    let keyData = localStorage.getItem('device_master_key');
    if (!keyData) {
        // Generate a new key on first launch
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
    const iv = new Uint8Array(encryptedObj.iv);
    const cipher = new Uint8Array(encryptedObj.cipher);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, masterKey, cipher);
    return new TextDecoder().decode(decrypted);
}

// --- APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    await initCrypto();
    await renderNodeList();
});

// --- UI: NODE MANAGEMENT ---
fabAddNode.addEventListener('click', () => {
    modalAddNode.classList.remove('hidden');
    formAddNode.reset();
    formAddNode.dataset.editId = ""; 
});

btnCancelNode.addEventListener('click', () => {
    modalAddNode.classList.add('hidden');
});

formAddNode.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('nodeName').value.trim();
    const provider = document.getElementById('nodeProvider').value;
    const model = document.getElementById('nodeModel').value.trim();
    const apiKeyRaw = document.getElementById('nodeApiKey').value.trim();
    const editId = formAddNode.dataset.editId;

    if (!name || !model) return;

    let nodeData = {
        name, provider, model,
        icon: provider.charAt(0).toUpperCase(),
        updatedAt: new Date().toISOString()
    };

    if (apiKeyRaw) {
        // Encrypt key before saving
        nodeData.encryptedKey = await encryptData(apiKeyRaw);
    } else if (!editId) {
        alert("API Key is required for new agents.");
        return;
    }

    if (editId) {
        await db.nodes.update(editId, nodeData);
    } else {
        nodeData.id = crypto.randomUUID();
        nodeData.createdAt = new Date().toISOString();
        await db.nodes.add(nodeData);
    }

    modalAddNode.classList.add('hidden');
    await renderNodeList();
});

async function renderNodeList() {
    nodeList.innerHTML = '';
    const nodes = await db.nodes.orderBy('updatedAt').reverse().toArray();

    if (nodes.length === 0) {
        nodeList.innerHTML = `<div style="padding: 32px; text-align: center; color: var(--text-secondary);">No AI Agents yet. Tap + to add one.</div>`;
        return;
    }

    nodes.forEach(node => {
        const li = document.createElement('li');
        li.className = 'node-item';
        li.innerHTML = `
            <div class="node-icon">${node.icon}</div>
            <div class="node-info">
                <div class="node-name">${node.name}</div>
                <div class="node-preview">${node.provider} • ${node.model}</div>
            </div>
        `;
        
        // Open Chat on click
        li.onclick = (e) => {
            if(e.target.closest('.node-icon')) {
                // Secret way to edit node: tap the icon
                document.getElementById('nodeName').value = node.name;
                document.getElementById('nodeProvider').value = node.provider;
                document.getElementById('nodeModel').value = node.model;
                document.getElementById('nodeApiKey').value = ""; // Key is hidden!
                formAddNode.dataset.editId = node.id;
                modalAddNode.classList.remove('hidden');
            } else {
                openChat(node);
            }
        };
        nodeList.appendChild(li);
    });
}

// --- UI: CHAT NAVIGATION ---
btnBack.addEventListener('click', () => {
    viewChat.classList.replace('view-active', 'view-hidden');
    viewMain.classList.replace('view-hidden', 'view-active');
    activeAgentId = null;
});

async function openChat(node) {
    activeAgentId = node.id;
    chatHeaderTitle.textContent = node.name;
    viewMain.classList.replace('view-active', 'view-hidden');
    viewChat.classList.replace('view-hidden', 'view-active');
    await loadChatHistory();
}

// --- CHAT LOGIC (Fast Path Streaming) ---
async function loadChatHistory() {
    messageList.innerHTML = '';
    const messages = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    messages.forEach(msg => renderMessage(msg.content, msg.role));
    scrollToBottom();
}

function renderMessage(content, role, id = null) {
    const div = document.createElement('div');
    div.className = `msg-bubble ${role === 'user' ? 'msg-user' : 'msg-ai'}`;
    div.textContent = content;
    if (id) div.id = id;
    messageList.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight < 120 ? this.scrollHeight : 120) + 'px';
});

btnSend.addEventListener('click', sendMessage);

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !activeAgentId) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnSend.disabled = true;

    // 1. Save and render User message
    const userMsg = { id: crypto.randomUUID(), agentId: activeAgentId, role: 'user', content: text, timestamp: Date.now() };
    await db.chats.add(userMsg);
    renderMessage(text, 'user');

    // 2. Fetch Agent Details & Decrypt Key in memory
    const agent = await db.nodes.get(activeAgentId);
    const apiKey = await decryptData(agent.encryptedKey);

    if (!apiKey) {
        renderMessage("Error: Missing or corrupt API key.", 'ai');
        btnSend.disabled = false;
        return;
    }

    // 3. Prepare message history for API
    const history = await db.chats.where('agentId').equals(activeAgentId).sortBy('timestamp');
    const apiMessages = history.map(m => ({ role: m.role, content: m.content }));

    // 4. Stream AI Response (Fast Path)
    const aiBubbleId = `msg-${crypto.randomUUID()}`;
    const aiBubble = renderMessage("...", 'ai', aiBubbleId);
    let fullResponse = "";

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: agent.model,
                messages: apiMessages,
                stream: true
            })
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        aiBubble.textContent = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        const content = data.choices[0]?.delta?.content || "";
                        fullResponse += content;
                        aiBubble.textContent = fullResponse;
                        scrollToBottom();
                    } catch (e) { /* ignore chunk breaks */ }
                }
            }
        }

        // 5. Save final AI message to local DB
        await db.chats.add({
            id: crypto.randomUUID(),
            agentId: activeAgentId,
            role: 'ai',
            content: fullResponse,
            timestamp: Date.now()
        });

    } catch (error) {
        aiBubble.textContent = `[Connection Failed] ${error.message}`;
    }

    btnSend.disabled = false;
    }
