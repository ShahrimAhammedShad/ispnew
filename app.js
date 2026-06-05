(function () {
  "use strict";

  const ADMIN_PASSWORD_HASH = "5616b00748424b555643e35b623f2e82430dc57e936b0da684c5e64b295f00b8";
  const STAFF_PASSWORD_HASH = "7a99d42d79e9bafeaa5ccedaf0135267da4ccd197a99131a8cf15025cb54ab18";
  const CYCLE_PASSWORD_HASH = "4c04b5c8b3882bb2344ec7f2c91c049492305c833b8b257cabad361432739df7";
  const STORAGE_KEY = "ispBillingManagerData";
  const SESSION_KEY = "ispBillingManagerSession";
  const LOGIN_GUARD_KEY = "ispBillingManagerLoginGuard";
  const SESSION_HOURS = 8;
  const MAX_LOGIN_ATTEMPTS = 5;
  const LOCKOUT_MINUTES = 10;
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBi_P7V5go_MEnxwEp3IAyaa9ZBhhGjILU",
    authDomain: "isp-billing-manager.firebaseapp.com",
    projectId: "isp-billing-manager",
    storageBucket: "isp-billing-manager.firebasestorage.app",
    messagingSenderId: "168891910826",
    appId: "1:168891910826:web:6654e525b3847eab3b5ed3"
  };
  const CLOUD_COLLECTION = "ispBillingManager";
  const CLOUD_DOCUMENT = "sharedData";

  const state = {
    role: null,
    user: null,
    customers: [],
    transactions: [],
    cycles: [],
    editingId: null,
    paymentCustomerId: null,
    lastReceipt: null,
    filters: { search: "", status: "all", sort: "name", history: "" },
    db: null,
    cloudDoc: null,
    cloudUnsubscribe: null,
    cloudReady: false,
    authReady: false,
    applyingRemote: false,
    syncTimer: null,
    lastSavedAt: null,
    collectionResetAt: null
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const els = {
    loader: $("#loader"),
    loginView: $("#loginView"),
    appView: $("#appView"),
    loginForm: $("#loginForm"),
    passwordInput: $("#passwordInput"),
    togglePassword: $("#togglePassword"),
    welcomeText: $("#welcomeText"),
    roleBadge: $("#roleBadge"),
    syncStatus: $("#syncStatus"),
    dateTimeText: $("#dateTimeText"),
    customerTable: $("#customerTable"),
    customerModal: $("#customerModal"),
    customerForm: $("#customerForm"),
    customerModalTitle: $("#customerModalTitle"),
    paymentModal: $("#paymentModal"),
    paymentForm: $("#paymentForm"),
    paymentCustomerInfo: $("#paymentCustomerInfo"),
    paymentAmount: $("#paymentAmount"),
    paymentNote: $("#paymentNote"),
    paymentDuePreview: $("#paymentDuePreview"),
    receiptModal: $("#receiptModal"),
    receiptContent: $("#receiptContent"),
    confirmModal: $("#confirmModal"),
    confirmTitle: $("#confirmTitle"),
    confirmMessage: $("#confirmMessage"),
    confirmPasswordWrap: $("#confirmPasswordWrap"),
    confirmPasswordInput: $("#confirmPasswordInput"),
    confirmCancelBtn: $("#confirmCancelBtn"),
    confirmOkBtn: $("#confirmOkBtn"),
    recentTransactions: $("#recentTransactions"),
    billingHistory: $("#billingHistory"),
    collectionSummary: $("#collectionSummary"),
    cycleHistory: $("#cycleHistory"),
    searchInput: $("#searchInput"),
    statusFilter: $("#statusFilter"),
    sortSelect: $("#sortSelect"),
    historySearch: $("#historySearch")
  };

  const money = (value) => `BDT ${Number(value || 0).toLocaleString("en-BD")}`;
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const monthKey = () => new Date().toISOString().slice(0, 7);
  const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const asNumber = (value) => Math.max(0, Number(value || 0));

  function loadData() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      stored = {};
      toast("Saved data was unreadable and has been reset.", "error");
    }
    state.customers = Array.isArray(stored.customers) ? stored.customers : [];
    state.transactions = Array.isArray(stored.transactions) ? stored.transactions : [];
    state.cycles = Array.isArray(stored.cycles) ? stored.cycles : [];
    state.lastSavedAt = stored.lastSavedAt || null;
    state.collectionResetAt = stored.collectionResetAt || null;
  }

  function saveData() {
    state.lastSavedAt = new Date().toISOString();
    const payload = getDataPayload();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    queueCloudSave(payload);
  }

  function saveLocalOnly(payload) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function getDataPayload() {
    return {
      customers: state.customers,
      transactions: state.transactions,
      cycles: state.cycles,
      lastSavedAt: state.lastSavedAt || new Date().toISOString(),
      collectionResetAt: state.collectionResetAt || null
    };
  }

  function setSyncStatus(message, mode = "info") {
    if (!els.syncStatus) return;
    els.syncStatus.textContent = message;
    els.syncStatus.dataset.mode = mode;
  }

  function cloudErrorText(error) {
    const code = error?.code || "";
    const message = error?.message || "";
    if (window.firebaseScriptFailed || !window.firebase) return "Firebase script blocked";
    if (code.includes("permission-denied") || message.includes("Missing or insufficient permissions")) return "Fix Firestore Rules";
    if (code.includes("unavailable")) return "Cloud unavailable";
    if (code.includes("not-found") || message.includes("NOT_FOUND")) return "Create Firestore DB";
    if (message.includes("client is offline")) return "Internet/Firebase offline";
    return "Cloud setup error";
  }

  function initCloudSync() {
    if (!window.firebase || !window.firebase.firestore || !window.firebase.auth) {
      setSyncStatus(window.firebaseScriptFailed ? "Firebase script blocked" : "Local mode", "error");
      return;
    }

    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      setSyncStatus("Securing cloud...");
      firebase.auth().signInAnonymously().then(() => {
        state.authReady = true;
        state.db = firebase.firestore();
        state.cloudDoc = state.db.collection(CLOUD_COLLECTION).doc(CLOUD_DOCUMENT);
        subscribeCloud();
      }).catch((error) => {
        state.cloudReady = false;
        setSyncStatus(cloudErrorText(error), "error");
      });
    } catch (error) {
      state.cloudReady = false;
      setSyncStatus(cloudErrorText(error), "error");
    }
  }

  function subscribeCloud() {
    if (!state.cloudDoc) return;
    if (state.cloudUnsubscribe) state.cloudUnsubscribe();
    setSyncStatus("Connecting cloud...");

    state.cloudUnsubscribe = state.cloudDoc.onSnapshot((snapshot) => {
      if (!snapshot.exists) {
        const localPayload = getDataPayload();
        if (localPayload.customers.length || localPayload.transactions.length || localPayload.cycles.length) {
          writeCloud(localPayload);
        }
        state.cloudReady = true;
        setSyncStatus("Cloud connected", "success");
        return;
      }

      const cloudData = normalizeCloudData(snapshot.data());
      const localTime = Date.parse(state.lastSavedAt || "1970-01-01");
      const cloudTime = Date.parse(cloudData.lastSavedAt || "1970-01-01");
      state.cloudReady = true;

      if (cloudTime >= localTime) {
        state.applyingRemote = true;
        state.customers = cloudData.customers;
        state.transactions = cloudData.transactions;
        state.cycles = cloudData.cycles;
        state.lastSavedAt = cloudData.lastSavedAt;
        state.collectionResetAt = cloudData.collectionResetAt;
        saveLocalOnly(cloudData);
        renderAll();
        state.applyingRemote = false;
      } else {
        writeCloud(getDataPayload());
      }

      setSyncStatus("Cloud synced", "success");
    }, (error) => {
      state.cloudReady = false;
      const message = cloudErrorText(error);
      setSyncStatus(message, "error");
      toast(`${message}. Local backup is still saved.`, "error");
    });
  }

  function normalizeCloudData(data) {
    return {
      customers: Array.isArray(data?.customers) ? data.customers : [],
      transactions: Array.isArray(data?.transactions) ? data.transactions : [],
      cycles: Array.isArray(data?.cycles) ? data.cycles : [],
      lastSavedAt: data?.lastSavedAt || null,
      collectionResetAt: data?.collectionResetAt || null
    };
  }

  function queueCloudSave(payload) {
    if (state.applyingRemote || !state.cloudDoc) return;
    clearTimeout(state.syncTimer);
    setSyncStatus("Syncing...");
    state.syncTimer = setTimeout(() => writeCloud(payload), 450);
  }

  function writeCloud(payload) {
    if (!state.cloudDoc) return;
    state.cloudDoc.set({
      ...payload,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).then(() => {
      state.cloudReady = true;
      setSyncStatus("Cloud synced", "success");
    }).catch((error) => {
      state.cloudReady = false;
      const message = cloudErrorText(error);
      setSyncStatus(message, "error");
      toast(`${message}. Local backup is still saved.`, "error");
    });
  }

  function getSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!session) return null;
      const expiresAt = Date.parse(session.expiresAt || "");
      if (!expiresAt || Date.now() > expiresAt) {
        clearSession();
        return null;
      }
      return session;
    } catch (error) {
      clearSession();
      return null;
    }
  }

  function setSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function getLoginGuard() {
    try {
      return JSON.parse(localStorage.getItem(LOGIN_GUARD_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function setLoginGuard(guard) {
    localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(guard));
  }

  function clearLoginGuard() {
    localStorage.removeItem(LOGIN_GUARD_KEY);
  }

  function isLockedOut() {
    const guard = getLoginGuard();
    return guard.lockedUntil && Date.now() < guard.lockedUntil;
  }

  function lockoutText() {
    const guard = getLoginGuard();
    const seconds = Math.ceil(((guard.lockedUntil || 0) - Date.now()) / 1000);
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Too many wrong attempts. Try again in ${minutes} minute(s).`;
  }

  function recordFailedLogin() {
    const guard = getLoginGuard();
    const attempts = Number(guard.attempts || 0) + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      setLoginGuard({ attempts, lockedUntil: Date.now() + LOCKOUT_MINUTES * 60 * 1000 });
      toast(lockoutText(), "error");
      return;
    }
    setLoginGuard({ attempts, lockedUntil: null });
    toast(`Invalid password. ${MAX_LOGIN_ATTEMPTS - attempts} attempt(s) left.`, "error");
  }

  async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function calculateCustomer(customer) {
    const monthlyBill = asNumber(customer.monthlyBill);
    const discount = asNumber(customer.discount);
    const previousDue = asNumber(customer.previousDue);
    const paidAmount = asNumber(customer.paidAmount);
    const totalBill = Math.max(0, monthlyBill - discount + previousDue);
    const currentDue = Math.max(0, totalBill - paidAmount);
    return { ...customer, monthlyBill, discount, previousDue, paidAmount, totalBill, currentDue };
  }

  function toast(message, type = "success") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("#toastHost").appendChild(node);
    setTimeout(() => node.remove(), 2800);
  }

  function requireAdmin() {
    if (state.role !== "admin") {
      toast("This action is restricted to admin.", "error");
      return false;
    }
    return true;
  }

  function showLogin() {
    els.appView.classList.add("hidden");
    els.loginView.classList.remove("hidden");
    document.body.classList.remove("staff");
  }

  function showApp(session) {
    state.role = session.role;
    state.user = session.user;
    document.body.classList.toggle("staff", state.role === "staff");
    els.roleBadge.textContent = state.role === "admin" ? "Admin" : "Staff";
    els.welcomeText.textContent = `Welcome ${state.user}`;
    els.loginView.classList.add("hidden");
    els.appView.classList.remove("hidden");
    setView(state.role === "staff" ? "customers" : "dashboard");
    renderAll();
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (isLockedOut()) {
      toast(lockoutText(), "error");
      return;
    }
    const password = els.passwordInput.value.trim();
    const passwordHash = await sha256(password);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    if (passwordHash === ADMIN_PASSWORD_HASH) {
      const session = { role: "admin", user: "Shad", signedInAt: new Date().toISOString(), expiresAt };
      clearLoginGuard();
      setSession(session);
      els.passwordInput.value = "";
      showApp(session);
      toast("Welcome Shad");
      return;
    }
    if (passwordHash === STAFF_PASSWORD_HASH) {
      const session = { role: "staff", user: "Alif", signedInAt: new Date().toISOString(), expiresAt };
      clearLoginGuard();
      setSession(session);
      els.passwordInput.value = "";
      showApp(session);
      toast("Welcome Alif");
      return;
    }
    recordFailedLogin();
  }

  function setView(name) {
    if (state.role === "staff" && ["dashboard", "billing", "reports"].includes(name)) name = "customers";
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}View`));
    $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
    $$(".mobile-nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
    $(".sidebar").classList.remove("open");
  }

  function updateClock() {
    els.dateTimeText.textContent = new Intl.DateTimeFormat("en-BD", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date());
  }

  function stats() {
    const customers = state.customers.map(calculateCustomer);
    const total = customers.length || 1;
    const currentMonth = monthKey();
    const today = todayKey();
    const resetTime = Date.parse(state.collectionResetAt || "1970-01-01");
    const visibleTransactions = state.transactions.filter((t) => Date.parse(t.date) >= resetTime);
    const monthTransactions = visibleTransactions.filter((t) => t.date.slice(0, 7) === currentMonth);
    return {
      totalCustomers: customers.length,
      active: customers.filter((c) => c.status === "Active").length,
      hold: customers.filter((c) => c.status === "Hold").length,
      inactive: customers.filter((c) => c.status === "Inactive").length,
      monthlyCollection: monthTransactions.reduce((sum, t) => sum + t.amount, 0),
      totalDue: customers.reduce((sum, c) => sum + c.currentDue, 0),
      todayCollection: visibleTransactions.filter((t) => t.date.slice(0, 10) === today).reduce((sum, t) => sum + t.amount, 0),
      revenue: customers.reduce((sum, c) => sum + Math.max(0, c.monthlyBill - c.discount), 0),
      activePercent: Math.round((customers.filter((c) => c.status === "Active").length / total) * 100),
      holdPercent: Math.round((customers.filter((c) => c.status === "Hold").length / total) * 100),
      inactivePercent: Math.round((customers.filter((c) => c.status === "Inactive").length / total) * 100)
    };
  }

  function renderDashboard() {
    const s = stats();
    $("#statTotalCustomers").textContent = s.totalCustomers;
    $("#statActive").textContent = s.active;
    $("#statHold").textContent = s.hold;
    $("#statInactive").textContent = s.inactive;
    $("#statMonthlyCollection").textContent = money(s.monthlyCollection);
    $("#statTotalDue").textContent = money(s.totalDue);
    $("#statTodayCollection").textContent = money(s.todayCollection);
    $("#statRevenue").textContent = money(s.revenue);
    $("#barActive").value = s.activePercent;
    $("#barHold").value = s.holdPercent;
    $("#barInactive").value = s.inactivePercent;

    const recent = state.transactions.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    els.recentTransactions.innerHTML = recent.length ? recent.map((t) => `
      <div class="activity-item">
        <div><strong>${escapeHtml(t.customerName)}</strong><br><small>${formatDate(t.date)}</small></div>
        <strong>${money(t.amount)}</strong>
      </div>
    `).join("") : `<div class="empty-state">No transactions yet.</div>`;
  }

  function filteredCustomers() {
    const term = state.filters.search.toLowerCase();
    return state.customers.map(calculateCustomer).filter((customer) => {
      const matchesSearch = customer.name.toLowerCase().includes(term) || customer.phone.toLowerCase().includes(term);
      const matchesStatus = state.filters.status === "all" || customer.status === state.filters.status;
      return matchesSearch && matchesStatus;
    }).sort((a, b) => {
      if (state.filters.sort === "due") return b.currentDue - a.currentDue;
      if (state.filters.sort === "bill") return b.totalBill - a.totalBill;
      if (state.filters.sort === "status") return a.status.localeCompare(b.status);
      return a.name.localeCompare(b.name);
    });
  }

  function renderCustomers() {
    const customers = filteredCustomers();
    els.customerTable.innerHTML = customers.length ? customers.map((c) => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong><br><small>${escapeHtml(c.address)}</small></td>
        <td data-label="Phone">${escapeHtml(c.phone)}</td>
        <td data-label="Monthly">${money(c.monthlyBill)}</td>
        <td data-label="Discount">${money(c.discount)}</td>
        <td data-label="Prev Due">${money(c.previousDue)}</td>
        <td data-label="Total Bill"><strong>${money(c.totalBill)}</strong></td>
        <td data-label="Paid">${money(c.paidAmount)}</td>
        <td data-label="Current Due"><strong>${money(c.currentDue)}</strong></td>
        <td data-label="Status">
          <select class="status-select" data-status-id="${c.id}">
            ${statusOptions(c.status).map((status) => `<option ${c.status === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </td>
        <td data-label="Actions">
          <div class="row-actions">
            <button class="secondary-btn" data-pay-id="${c.id}">Pay</button>
            <button class="secondary-btn" data-invoice-id="${c.id}">Invoice</button>
            ${state.role === "admin" ? `<button class="secondary-btn" data-edit-id="${c.id}">Edit</button><button class="danger-btn" data-delete-id="${c.id}">Delete</button>` : ""}
          </div>
        </td>
      </tr>
    `).join("") : `<tr><td colspan="10" class="empty-state">No customers found.</td></tr>`;
  }

  function renderBillingHistory() {
    const term = state.filters.history.toLowerCase();
    const transactions = state.transactions
      .filter((t) => t.customerName.toLowerCase().includes(term) || t.phone.toLowerCase().includes(term) || t.receiptNo.toLowerCase().includes(term))
      .sort((a, b) => b.date.localeCompare(a.date));
    els.billingHistory.innerHTML = transactions.length ? transactions.map((t) => `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(t.customerName)}</strong>
          <br><small>${escapeHtml(t.phone)} - ${formatDate(t.date)} - ${escapeHtml(t.receiptNo)}</small>
        </div>
        <div><strong>${money(t.amount)}</strong><br><small>Due ${money(t.dueAfter)}</small></div>
      </div>
    `).join("") : `<div class="empty-state">No billing history found.</div>`;
  }

  function renderReports() {
    const byMonth = state.transactions.reduce((map, tx) => {
      const key = tx.date.slice(0, 7);
      map[key] = (map[key] || 0) + tx.amount;
      return map;
    }, {});
    const months = Object.keys(byMonth).sort().reverse();
    els.collectionSummary.innerHTML = months.length ? months.map((key) => `
      <div class="summary-item"><span>${key}</span><strong>${money(byMonth[key])}</strong></div>
    `).join("") : `<div class="empty-state">No collection reports yet.</div>`;
    els.cycleHistory.innerHTML = state.cycles.length ? state.cycles.slice().reverse().map((cycle) => `
      <div class="summary-item">
        <span>${escapeHtml(cycle.month)}<br><small>${formatDate(cycle.date)}</small></span>
        <strong>${cycle.customerCount} customers</strong>
      </div>
    `).join("") : `<div class="empty-state">No monthly cycle has been run.</div>`;
  }

  function renderAll() {
    renderDashboard();
    renderCustomers();
    renderBillingHistory();
    renderReports();
  }

  function statusOptions(currentStatus) {
    if (state.role === "admin") return ["Active", "Hold", "Inactive"];
    const options = ["Active", "Hold"];
    if (currentStatus === "Inactive") options.push("Inactive");
    return options;
  }

  function openCustomerModal(customerId = null) {
    if (!requireAdmin()) return;
    state.editingId = customerId;
    const customer = customerId ? state.customers.find((c) => c.id === customerId) : null;
    els.customerModalTitle.textContent = customer ? "Edit Customer" : "Add Customer";
    $("#customerName").value = customer?.name || "";
    $("#customerPhone").value = customer?.phone || "";
    $("#customerAddress").value = customer?.address || "";
    $("#monthlyBill").value = customer?.monthlyBill || "";
    $("#discountAmount").value = customer?.discount || 0;
    $("#previousDue").value = customer?.previousDue || 0;
    $("#paidAmount").value = customer?.paidAmount || 0;
    $("#accountStatus").value = customer?.status || "Active";
    $("#customerNotes").value = customer?.notes || "";
    updateCustomerPreview();
    els.customerModal.classList.remove("hidden");
  }

  function updateCustomerPreview() {
    const customer = calculateCustomer({
      monthlyBill: $("#monthlyBill").value,
      discount: $("#discountAmount").value,
      previousDue: $("#previousDue").value,
      paidAmount: $("#paidAmount").value
    });
    $("#previewTotalBill").textContent = money(customer.totalBill);
    $("#previewCurrentDue").textContent = money(customer.currentDue);
  }

  function saveCustomer(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const customer = calculateCustomer({
      id: state.editingId || uid(),
      name: $("#customerName").value.trim(),
      phone: $("#customerPhone").value.trim(),
      address: $("#customerAddress").value.trim(),
      monthlyBill: $("#monthlyBill").value,
      discount: $("#discountAmount").value,
      previousDue: $("#previousDue").value,
      paidAmount: $("#paidAmount").value,
      status: $("#accountStatus").value,
      notes: $("#customerNotes").value.trim(),
      createdAt: state.customers.find((c) => c.id === state.editingId)?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (!customer.name || !customer.phone) {
      toast("Customer name and phone are required.", "error");
      return;
    }
    const index = state.customers.findIndex((c) => c.id === state.editingId);
    if (index >= 0) state.customers[index] = customer;
    else state.customers.unshift(customer);
    saveData();
    closeModal("customerModal");
    renderAll();
    toast(index >= 0 ? "Customer updated." : "Customer added.");
  }

  function openPaymentModal(customerId) {
    const found = state.customers.find((c) => c.id === customerId);
    if (!found) return;
    const customer = calculateCustomer(found);
    state.paymentCustomerId = customerId;
    els.paymentCustomerInfo.innerHTML = `
      <strong>${escapeHtml(customer.name)}</strong>
      <span>${escapeHtml(customer.phone)} - ${escapeHtml(customer.status)}</span>
      <span>Total Bill ${money(customer.totalBill)} - Current Due ${money(customer.currentDue)}</span>
    `;
    els.paymentAmount.value = customer.currentDue || customer.totalBill || "";
    els.paymentNote.value = "";
    updatePaymentPreview();
    els.paymentModal.classList.remove("hidden");
  }

  function updatePaymentPreview() {
    const customer = calculateCustomer(state.customers.find((c) => c.id === state.paymentCustomerId) || {});
    const payment = asNumber(els.paymentAmount.value);
    els.paymentDuePreview.textContent = money(Math.max(0, customer.currentDue - payment));
  }

  function receivePayment(event) {
    event.preventDefault();
    const index = state.customers.findIndex((c) => c.id === state.paymentCustomerId);
    if (index < 0) return;
    const customer = calculateCustomer(state.customers[index]);
    const amount = asNumber(els.paymentAmount.value);
    if (amount <= 0) {
      toast("Enter a valid payment amount.", "error");
      return;
    }
    const dueAfter = Math.max(0, customer.currentDue - amount);
    const updated = calculateCustomer({ ...customer, paidAmount: customer.paidAmount + amount });
    state.customers[index] = updated;
    const transaction = {
      id: uid(),
      receiptNo: `RCPT-${Date.now().toString().slice(-8)}`,
      customerId: customer.id,
      customerName: customer.name,
      phone: customer.phone,
      amount,
      totalBill: customer.totalBill,
      dueBefore: customer.currentDue,
      dueAfter,
      note: els.paymentNote.value.trim(),
      date: new Date().toISOString(),
      receivedBy: state.user
    };
    state.transactions.unshift(transaction);
    state.lastReceipt = transaction;
    saveData();
    closeModal("paymentModal");
    renderAll();
    renderReceipt(transaction);
    els.receiptModal.classList.remove("hidden");
    toast("Payment received.");
  }

  function renderReceipt(tx) {
    $("#receiptTitle").textContent = "Payment Receipt";
    $("#printReceiptBtn").textContent = "Print Receipt";
    els.receiptContent.innerHTML = `
      <h2>ISP Billing Manager</h2>
      <p style="text-align:center;margin-bottom:1rem;">Payment Receipt</p>
      <div class="receipt-row"><span>Receipt No</span><strong>${escapeHtml(tx.receiptNo)}</strong></div>
      <div class="receipt-row"><span>Date</span><strong>${formatDate(tx.date)}</strong></div>
      <div class="receipt-row"><span>Customer</span><strong>${escapeHtml(tx.customerName)}</strong></div>
      <div class="receipt-row"><span>Phone</span><strong>${escapeHtml(tx.phone)}</strong></div>
      <div class="receipt-row"><span>Total Bill</span><strong>${money(tx.totalBill)}</strong></div>
      <div class="receipt-row"><span>Paid</span><strong>${money(tx.amount)}</strong></div>
      <div class="receipt-row"><span>Due After Payment</span><strong>${money(tx.dueAfter)}</strong></div>
      <div class="receipt-row"><span>Received By</span><strong>${escapeHtml(tx.receivedBy)}</strong></div>
      <p style="text-align:center;margin:1.2rem 0 0;">Thank you for your payment.</p>
    `;
  }

  async function deleteCustomer(customerId) {
    if (!requireAdmin()) return;
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) return;
    const confirmed = await askConfirm({
      title: "Delete Customer",
      message: `Delete ${customer.name}? This will remove the customer record from this app and cloud sync.`,
      okText: "Delete"
    });
    if (!confirmed) return;
    state.customers = state.customers.filter((c) => c.id !== customerId);
    saveData();
    renderAll();
    toast("Customer deleted.");
  }

  function changeStatus(customerId, status) {
    const customer = state.customers.find((c) => c.id === customerId);
    if (!customer) return;
    const calculated = calculateCustomer(customer);
    if (state.role !== "admin" && customer.status === "Hold" && status === "Active" && calculated.currentDue > 0) {
      toast("Due account on Hold can be activated by admin only.", "error");
      renderCustomers();
      return;
    }
    customer.status = status;
    customer.updatedAt = new Date().toISOString();
    saveData();
    renderAll();
    toast("Account status updated.");
  }

  async function runMonthlyCycle() {
    if (!requireAdmin()) return;
    const currentMonth = monthKey();
    const alreadyRun = state.cycles.some((cycle) => cycle.month === currentMonth);
    const confirmed = await askConfirm({
      title: "Run Monthly Cycle",
      message: alreadyRun
        ? "This month already has a billing cycle. Enter cycle password to run it again and reset dashboard collection counters."
        : "Enter cycle password to run monthly billing cycle. Current dues will become previous due and collection counters will reset.",
      okText: "Run Cycle",
      passwordHash: CYCLE_PASSWORD_HASH
    });
    if (!confirmed) return;
    state.customers = state.customers.map((customer) => {
      const current = calculateCustomer(customer);
      return calculateCustomer({
        ...current,
        previousDue: current.currentDue,
        paidAmount: 0,
        status: "Hold",
        updatedAt: new Date().toISOString()
      });
    });
    state.cycles.push({ id: uid(), month: currentMonth, date: new Date().toISOString(), customerCount: state.customers.length });
    state.collectionResetAt = new Date().toISOString();
    saveData();
    renderAll();
    toast("Monthly billing cycle completed.");
  }

  function renderInvoice(customerId) {
    const customer = calculateCustomer(state.customers.find((c) => c.id === customerId) || {});
    if (!customer.id) return;
    $("#receiptTitle").textContent = "Customer Invoice";
    $("#printReceiptBtn").textContent = "Print Invoice";
    els.receiptContent.innerHTML = `
      <h2>ISP Billing Manager</h2>
      <p style="text-align:center;margin-bottom:1rem;">Customer Invoice</p>
      <div class="receipt-row"><span>Date</span><strong>${formatDate(new Date().toISOString())}</strong></div>
      <div class="receipt-row"><span>Customer</span><strong>${escapeHtml(customer.name)}</strong></div>
      <div class="receipt-row"><span>Phone</span><strong>${escapeHtml(customer.phone)}</strong></div>
      <div class="receipt-row"><span>Address</span><strong>${escapeHtml(customer.address)}</strong></div>
      <div class="receipt-row"><span>Status</span><strong>${escapeHtml(customer.status)}</strong></div>
      <div class="receipt-row"><span>Monthly Bill</span><strong>${money(customer.monthlyBill)}</strong></div>
      <div class="receipt-row"><span>Discount</span><strong>${money(customer.discount)}</strong></div>
      <div class="receipt-row"><span>Previous Due</span><strong>${money(customer.previousDue)}</strong></div>
      <div class="receipt-row"><span>Total Bill</span><strong>${money(customer.totalBill)}</strong></div>
      <div class="receipt-row"><span>Paid Amount</span><strong>${money(customer.paidAmount)}</strong></div>
      <div class="receipt-row"><span>Current Due</span><strong>${money(customer.currentDue)}</strong></div>
      <p style="text-align:center;margin:1.2rem 0 0;">Please pay your bill on time.</p>
    `;
    els.receiptModal.classList.remove("hidden");
  }

  function askConfirm({ title, message, okText, passwordHash = null }) {
    return new Promise((resolve) => {
      els.confirmTitle.textContent = title;
      els.confirmMessage.textContent = message;
      els.confirmOkBtn.textContent = okText || "Confirm";
      els.confirmPasswordInput.value = "";
      els.confirmPasswordWrap.classList.toggle("hidden", !passwordHash);
      els.confirmModal.classList.remove("hidden");
      if (passwordHash) setTimeout(() => els.confirmPasswordInput.focus(), 80);

      const cleanup = (result) => {
        els.confirmModal.classList.add("hidden");
        els.confirmPasswordInput.value = "";
        els.confirmOkBtn.removeEventListener("click", onOk);
        els.confirmCancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const onOk = async () => {
        if (passwordHash) {
          const enteredHash = await sha256(els.confirmPasswordInput.value.trim());
          if (enteredHash !== passwordHash) {
            toast("Wrong cycle password.", "error");
            return;
          }
        }
        cleanup(true);
      };
      const onCancel = () => cleanup(false);
      els.confirmOkBtn.addEventListener("click", onOk);
      els.confirmCancelBtn.addEventListener("click", onCancel);
    });
  }

  function exportCsv() {
    if (!requireAdmin()) return;
    const headers = ["Name", "Phone", "Address", "Monthly Bill", "Discount", "Previous Due", "Total Bill", "Paid", "Current Due", "Status", "Notes"];
    const rows = filteredCustomers().map((c) => [c.name, c.phone, c.address, c.monthlyBill, c.discount, c.previousDue, c.totalBill, c.paidAmount, c.currentDue, c.status, c.notes]);
    const table = `
      <html><head><meta charset="UTF-8"></head><body>
      <table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </body></html>
    `;
    download(new Blob([table], { type: "application/vnd.ms-excel;charset=utf-8" }), `isp-customers-${todayKey()}.xls`);
  }

  function exportPdf() {
    if (!requireAdmin()) return;
    const customers = filteredCustomers();
    const win = window.open("", "_blank");
    if (!win) {
      toast("Allow popups to export PDF.", "error");
      return;
    }
    win.document.write(`
      <!doctype html><html><head><title>ISP Customer Report</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:7px;text-align:left}th{background:#eef5f8}h1{margin-bottom:4px}</style>
      </head><body><h1>ISP Billing Manager</h1><p>Customer report generated ${formatDate(new Date().toISOString())}</p>
      <table><thead><tr><th>Name</th><th>Phone</th><th>Monthly</th><th>Discount</th><th>Prev Due</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th></tr></thead>
      <tbody>${customers.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone)}</td><td>${money(c.monthlyBill)}</td><td>${money(c.discount)}</td><td>${money(c.previousDue)}</td><td>${money(c.totalBill)}</td><td>${money(c.paidAmount)}</td><td>${money(c.currentDue)}</td><td>${escapeHtml(c.status)}</td></tr>`).join("")}</tbody></table>
      <script>window.onload=()=>{window.print();};<\/script></body></html>
    `);
    win.document.close();
  }

  function download(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function closeModal(id) {
    $(`#${id}`).classList.add("hidden");
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat("en-BD", {
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(date));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
  }

  function bindEvents() {
    els.loginForm.addEventListener("submit", handleLogin);
    els.togglePassword.addEventListener("click", () => {
      const isPassword = els.passwordInput.type === "password";
      els.passwordInput.type = isPassword ? "text" : "password";
      els.togglePassword.textContent = isPassword ? "Hide" : "Show";
    });
    $("#logoutBtn").addEventListener("click", () => {
      clearSession();
      state.role = null;
      showLogin();
      toast("Logged out.");
    });
    $("#menuToggle").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
    $("#themeToggle").addEventListener("click", () => {
      document.body.classList.toggle("dark");
      localStorage.setItem("ispBillingTheme", document.body.classList.contains("dark") ? "dark" : "light");
      $("#themeToggle").textContent = document.body.classList.contains("dark") ? "Light Mode" : "Dark Mode";
    });
    $$(".nav-link").forEach((link) => link.addEventListener("click", () => setView(link.dataset.view)));
    $$(".mobile-nav-link").forEach((link) => link.addEventListener("click", () => setView(link.dataset.view)));
    $$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewJump)));
    $("#addCustomerBtn").addEventListener("click", () => openCustomerModal());
    $("#cycleBtn").addEventListener("click", runMonthlyCycle);
    $("#exportCsvBtn").addEventListener("click", exportCsv);
    $("#exportPdfBtn").addEventListener("click", exportPdf);
    $("#printReceiptBtn").addEventListener("click", () => window.print());
    els.customerForm.addEventListener("submit", saveCustomer);
    els.paymentForm.addEventListener("submit", receivePayment);
    ["monthlyBill", "discountAmount", "previousDue", "paidAmount"].forEach((id) => $(`#${id}`).addEventListener("input", updateCustomerPreview));
    els.paymentAmount.addEventListener("input", updatePaymentPreview);
    els.searchInput.addEventListener("input", (e) => { state.filters.search = e.target.value; renderCustomers(); });
    els.statusFilter.addEventListener("change", (e) => { state.filters.status = e.target.value; renderCustomers(); });
    els.sortSelect.addEventListener("change", (e) => { state.filters.sort = e.target.value; renderCustomers(); });
    els.historySearch.addEventListener("input", (e) => { state.filters.history = e.target.value; renderBillingHistory(); });
    $$(".close-modal").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
    $$(".modal").forEach((modal) => modal.addEventListener("click", (event) => {
      if (modal.id === "confirmModal") return;
      if (event.target === modal) closeModal(modal.id);
    }));
    els.customerTable.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.payId) openPaymentModal(button.dataset.payId);
      if (button.dataset.invoiceId) renderInvoice(button.dataset.invoiceId);
      if (button.dataset.editId) openCustomerModal(button.dataset.editId);
      if (button.dataset.deleteId) deleteCustomer(button.dataset.deleteId);
    });
    els.customerTable.addEventListener("change", (event) => {
      const select = event.target.closest("[data-status-id]");
      if (select) changeStatus(select.dataset.statusId, select.value);
    });
  }

  function initTheme() {
    const theme = localStorage.getItem("ispBillingTheme");
    document.body.classList.toggle("dark", theme === "dark");
    $("#themeToggle").textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
  }

  function init() {
    loadData();
    bindEvents();
    initTheme();
    initCloudSync();
    updateClock();
    setInterval(updateClock, 1000);
    const session = getSession();
    setTimeout(() => {
      els.loader.classList.add("hidden");
      if (session?.role && session?.user) showApp(session);
      else showLogin();
    }, 450);
  }

  init();
})();
