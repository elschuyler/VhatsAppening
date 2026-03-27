// --- DATABASE INITIALIZATION (Dexie.js) ---
const db = new Dexie('VhatsAppeningDB');

db.version(1).stores({
    nodes: 'id, name, provider, updatedAt', // AI Agents
    chats: 'id, agentId, dirty',            // Conversations (For Phase 2)
    syncQueue: '++id, type, status',        // Async operations (For Phase 3/4)
    settings: 'id'                          // App preferences
});

// --- DOM ELEMENTS ---
const nodeList = document.getElementById('nodeList');
const fabAddNode = document.getElementById('fabAddNode');
const modalAddNode = document.getElementById('modalAddNode');
const btnCancelNode = document.getElementById('btnCancelNode');
const formAddNode = document.getElementById('formAddNode');

// --- APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    await renderNodeList();
});

// --- UI LOGIC ---

// Open Modal
fabAddNode.addEventListener('click', () => {
    modalAddNode.classList.remove('hidden');
    formAddNode.reset();
});

// Close Modal
btnCancelNode.addEventListener('click', () => {
    modalAddNode.classList.add('hidden');
});

// Handle Form Submission (Add Node)
formAddNode.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('nodeName').value.trim();
    const provider = document.getElementById('nodeProvider').value;
    const model = document.getElementById('nodeModel').value.trim();
    const apiKey = document.getElementById('nodeApiKey').value.trim();

    if (!name || !model || !apiKey) return;

    const newNode = {
        id: crypto.randomUUID(),
        name: name,
        provider: provider,
        model: model,
        apiKeyPlaintext: apiKey, // Stored in plaintext as requested (No-PIN mode)
        icon: provider.charAt(0).toUpperCase(), // Simple initial for icon
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        await db.nodes.add(newNode);
        modalAddNode.classList.add('hidden');
        await renderNodeList();
    } catch (error) {
        console.error("Failed to save node:", error);
        alert("Failed to save AI Agent.");
    }
});

// Render the List of Agents
async function renderNodeList() {
    nodeList.innerHTML = '';
    
    try {
        // Fetch all nodes, sorted by newest first
        const nodes = await db.nodes.orderBy('updatedAt').reverse().toArray();

        if (nodes.length === 0) {
            nodeList.innerHTML = `
                <div style="padding: 32px; text-align: center; color: var(--text-secondary);">
                    No AI Agents yet. Tap + to add one.
                </div>
            `;
            return;
        }

        nodes.forEach(node => {
            const li = document.createElement('li');
            li.className = 'node-item';
            // In Phase 2, this will navigate to the Chat Room
            li.onclick = () => alert(`Chat room for ${node.name} will be built in Phase 2!`);

            li.innerHTML = `
                <div class="node-icon">${node.icon}</div>
                <div class="node-info">
                    <div class="node-name">${node.name}</div>
                    <div class="node-preview">${node.provider} • ${node.model}</div>
                </div>
            `;
            nodeList.appendChild(li);
        });
    } catch (error) {
        console.error("Failed to load nodes:", error);
    }
                             }
