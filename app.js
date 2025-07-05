// app.js

// --- Helper, Parser, and other functions ---
function convertKeysToCamelCase(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => convertKeysToCamelCase(v));
  return Object.keys(obj).reduce((acc, key) => {
    const camelCaseKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    acc[camelCaseKey] = convertKeysToCamelCase(obj[key]);
    return acc;
  }, {});
}

function parseTextprotoToJsObject(textprotoString) {
  const obj = {};
  const lines = textprotoString.split(/\r?\n/);
  const currentObjectStack = [obj];
  let currentObject = obj;
  const repeatedFields = new Set(["main_actor", "doramas"]);
  lines.forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    const matchMessageStart = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\{$/);
    const matchMessageEnd = line.match(/^\}$/);
    const matchField = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (matchMessageStart) {
      const messageName = matchMessageStart[1];
      const newObject = {};
      if (repeatedFields.has(messageName)) {
        if (!currentObject[messageName]) currentObject[messageName] = [];
        currentObject[messageName].push(newObject);
      } else {
        currentObject[messageName] = newObject;
      }
      currentObjectStack.push(currentObject);
      currentObject = newObject;
    } else if (matchMessageEnd) {
      currentObject = currentObjectStack.pop();
    } else if (matchField) {
      const fieldName = matchField[1];
      let valueStr = matchField[2].trim();
      let finalValue;
      if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
        finalValue = valueStr.substring(1, valueStr.length - 1);
      } else if (valueStr.toLowerCase() === "true") {
        finalValue = true;
      } else if (valueStr.toLowerCase() === "false") {
        finalValue = false;
      } else if (valueStr !== "" && !isNaN(Number(valueStr))) {
        finalValue = Number(valueStr);
      } else {
        finalValue = valueStr;
      }
      if (repeatedFields.has(fieldName)) {
        if (!Array.isArray(currentObject[fieldName]))
          currentObject[fieldName] = [];
        currentObject[fieldName].push(finalValue);
      } else {
        currentObject[fieldName] = finalValue;
      }
    }
  });
  return obj;
}

function updatePersistedHighlights(doramaId, isHighlighted) {
  const highlightedIds =
    JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];
  const index = highlightedIds.indexOf(doramaId);
  if (isHighlighted && index === -1) {
    highlightedIds.push(doramaId);
  } else if (!isHighlighted && index > -1) {
    highlightedIds.splice(index, 1);
  }
  localStorage.setItem("highlightedDoramaIds", JSON.stringify(highlightedIds));
}

// --- Module-level variables ---
let allDoramas = []; // For the currently displayed dataset
let completeDoramaDataset = []; // START: New variable for the "全部" dataset
let currentDataSourceFile = "";
let activeActorFilter = "";
let searchTerm = "";
let displayedCountPerYear = {}; // Track how many doramas are displayed per year

// --- Custom Dialog System ---
function showCustomDialog(title, message, buttons) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-dialog-modal");
    const titleEl = document.getElementById("dialog-title");
    const messageEl = document.getElementById("dialog-message");
    const buttonsContainer = document.getElementById("dialog-buttons");
    const closeBtn = document.getElementById("dialog-close-btn");

    titleEl.textContent = title;
    messageEl.textContent = message;

    // Clear previous buttons
    buttonsContainer.innerHTML = '';

    // Add buttons
    buttons.forEach((button, index) => {
      const btn = document.createElement("button");
      btn.textContent = button.text;
      btn.className = `dialog-btn ${button.class || 'dialog-btn-light'}`;
      btn.onclick = () => {
        closeDialog();
        resolve(button.value);
      };
      buttonsContainer.appendChild(btn);

      // Auto-focus first button
      if (index === 0) {
        setTimeout(() => btn.focus(), 100);
      }
    });

    // Close button
    closeBtn.onclick = () => {
      closeDialog();
      resolve(null);
    };

    // Close on escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeDialog();
        resolve(null);
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Close on backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) {
        closeDialog();
        resolve(null);
      }
    };

    function closeDialog() {
      modal.style.display = "none";
      document.body.classList.remove("modal-open");
      document.removeEventListener('keydown', handleEscape);
    }

    // Show modal
    modal.style.display = "flex";
    document.body.classList.add("modal-open");
  });
}

function showAlert(title, message) {
  return showCustomDialog(title, message, [
    { text: "確定", value: true, class: "dialog-btn-primary" }
  ]);
}

function showConfirm(title, message) {
  return showCustomDialog(title, message, [
    { text: "確定", value: true, class: "dialog-btn-primary" },
    { text: "取消", value: false, class: "dialog-btn-light" }
  ]);
}

// --- Fuzzy Matching and File Parsing Logic ---

/**
 * Calculates the Levenshtein distance between two strings.
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @returns {number} The Levenshtein distance.
 */
function levenshteinDistance(a, b) {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array(an + 1);
  for (let i = 0; i <= an; i++) matrix[i] = Array(bn + 1);
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // Deletion
        matrix[i][j - 1] + 1,      // Insertion
        matrix[i - 1][j - 1] + cost // Substitution
      );
    }
  }
  return matrix[an][bn];
}

/**
 * START: New function to load the complete dataset if it's not already loaded.
 * This ensures we have all doramas available for matching.
 */
async function ensureCompleteDatasetIsLoaded() {
    if (completeDoramaDataset.length > 0) {
        return; // Already loaded
    }

    const statusDiv = document.getElementById("share-status");
    try {
        statusDiv.textContent = '首次解析：正在載入完整資料庫...';
        const protoResponse = await fetch("dorama_info.proto");
        const protoContent = await protoResponse.text();
        const root = protobuf.parse(protoContent).root;
        const DoramaInfoMessage = root.lookupType("dorama.DoramaInfo");

        const textprotoResponse = await fetch("dorama_info.txtpb");
        const textprotoContent = await textprotoResponse.text();

        const plainJsObject = parseTextprotoToJsObject(textprotoContent);
        const camelCaseObject = convertKeysToCamelCase(plainJsObject);
        const doramaInfoInstance = DoramaInfoMessage.fromObject(camelCaseObject);
        
        completeDoramaDataset = doramaInfoInstance.doramas || [];
        statusDiv.textContent = '完整資料庫載入完畢。';
        setTimeout(() => { statusDiv.textContent = ''; }, 3000);

    } catch (error) {
        console.error("無法載入完整資料庫進行比對:", error);
        showAlert("比對錯誤", "無法載入完整資料庫，請稍後再試。");
        statusDiv.textContent = '';
        throw error; // Propagate error to stop the parsing process
    }
}
// END: New function

/**
 * Finds the best fuzzy matches for a query string from a given dataset.
 * @param {string} query The string to match.
 * @param {Array} dataset The dorama dataset to search within. // START: Updated parameter
 * @returns {Array} A sorted list of match objects { dorama, score }.
 */
function findFuzzyMatches(query, dataset) { // START: Updated signature
  const normalizedQuery = query.toLowerCase();
  const matches = [];
  const threshold = 0.6;

  // Use the provided dataset for matching
  dataset.forEach(dorama => { // START: Use the 'dataset' parameter
    const titles = [dorama.chineseTitle, dorama.japaneseTitle].filter(Boolean);
    let bestScore = 0;

    titles.forEach(title => {
      const normalizedTitle = title.toLowerCase();
      const distance = levenshteinDistance(normalizedQuery, normalizedTitle);
      const score = 1 - (distance / Math.max(normalizedQuery.length, normalizedTitle.length));

      if (score > bestScore) {
        bestScore = score;
      }
    });

    if (bestScore >= threshold) {
      matches.push({ dorama, score: bestScore });
    }
  });

  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Handles the file parsing process. Now ensures the complete dataset is loaded
 * before performing a fuzzy match against it.
 * @param {File} file The file uploaded by the user.
 */
async function handleFileParse(file) {
    const reader = new FileReader();

    reader.onload = async (e) => {
        try {
            // START: Ensure complete dataset is loaded before proceeding
            await ensureCompleteDatasetIsLoaded();
            // END

            const content = e.target.result;
            let queries = [];

            if (content.includes(',')) {
                const lines = content.split('\n');
                const allFields = lines.flatMap(line => parseCSVLine(line));
                queries = allFields.map(field => field.trim()).filter(Boolean);
            } else {
                queries = content.split('\n').map(line => line.trim()).filter(Boolean);
            }

            if (queries.length === 0) {
                await showAlert("檔案錯誤", "檔案為空或無法解析出有效內容。");
                return;
            }

            const results = queries.map(query => ({
                original: query,
                // START: Pass the complete dataset to the matching function
                matches: findFuzzyMatches(query, completeDoramaDataset)
                // END
            }));

            showFuzzyMatchReviewModal(results);

        } catch (error) {
            // Error handling is managed within ensureCompleteDatasetIsLoaded
            // so we just need to stop the process here.
            console.log("停止解析，因為無法載入完整資料庫。");
        }
    };

    reader.onerror = async () => {
        await showAlert("讀取錯誤", "讀取檔案時發生錯誤。");
    };

    reader.readAsText(file);
}


/**
 * Displays a modal for the user to review and confirm fuzzy matches.
 * @param {Array} results The matching results to display.
 */
function showFuzzyMatchReviewModal(results) {
    const modal = document.getElementById('fuzzy-match-modal');
    const body = document.getElementById('fuzzy-match-body');
    const buttonsContainer = document.getElementById('fuzzy-match-buttons');
    const closeBtn = document.getElementById('fuzzy-match-close-btn');
    
    body.innerHTML = ''; // Clear previous content

    results.forEach((result, index) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'fuzzy-match-item';

        let optionsHtml = '';
        if (result.matches.length > 0) {
            result.matches.forEach(match => {
                optionsHtml += `
                    <label class="fuzzy-match-option">
                        <input type="radio" name="match-group-${index}" value="${match.dorama.doramaInfoId}">
                        <span class="match-details">
                            <span class="title">${match.dorama.chineseTitle} (${match.dorama.japaneseTitle})</span>
                            <span class="year">${match.dorama.releaseYear}</span>
                            <span class="score">(相似度: ${Math.round(match.score * 100)}%)</span>
                        </span>
                    </label>
                `;
            });
        } else {
            optionsHtml = '<p class="no-match-found">找不到可能的比對結果。</p>';
        }

        itemEl.innerHTML = `
            <div class="fuzzy-match-original-text">
                解析文字: <span>"${result.original}"</span>
            </div>
            <div class="fuzzy-match-options-container">
                ${optionsHtml}
                <label class="fuzzy-match-option">
                    <input type="radio" name="match-group-${index}" value="reject" checked>
                    <span>忽略此項目</span>
                </label>
            </div>
        `;
        body.appendChild(itemEl);
    });
    
    // Add listeners to visually indicate selection
    body.querySelectorAll('.fuzzy-match-option input').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const groupName = e.target.name;
            document.querySelectorAll(`input[name="${groupName}"]`).forEach(r => {
                r.closest('.fuzzy-match-option').classList.remove('selected');
            });
            e.target.closest('.fuzzy-match-option').classList.add('selected');
        });
    });

    // Setup modal buttons
    buttonsContainer.innerHTML = `
        <button id="confirm-matches-btn" class="dialog-btn dialog-btn-primary">確認並合併標記</button>
        <button id="cancel-matches-btn" class="dialog-btn dialog-btn-light">取消</button>
    `;

    const closeDialog = () => {
        modal.style.display = 'none';
        document.body.classList.remove('modal-open');
    };

    document.getElementById('confirm-matches-btn').onclick = () => {
        const selectedIds = new Set();
        results.forEach((_, index) => {
            const selectedRadio = document.querySelector(`input[name="match-group-${index}"]:checked`);
            if (selectedRadio && selectedRadio.value !== 'reject') {
                selectedIds.add(selectedRadio.value);
            }
        });

        if (selectedIds.size > 0) {
            const existingHighlightedIds = JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];
            const mergedIds = [...new Set([...existingHighlightedIds, ...Array.from(selectedIds)])];
            localStorage.setItem("highlightedDoramaIds", JSON.stringify(mergedIds));
            
            // Re-apply all highlights
            applyAllFilters(); 
            
            const shareStatus = document.getElementById("share-status");
            shareStatus.textContent = `已成功合併標記 ${selectedIds.size} 部日劇。`;
            setTimeout(() => { shareStatus.textContent = ""; }, 4000);
        }
        
        closeDialog();
    };

    document.getElementById('cancel-matches-btn').onclick = closeDialog;
    closeBtn.onclick = closeDialog;

    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
}


// --- CSV Import/Export Functions ---
async function exportHighlightedDoramasToCSV() {
  const highlightedIds = JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];

  if (highlightedIds.length === 0) {
    await showAlert("匯出錯誤", "沒有已標記日劇可以匯出");
    return;
  }

  // Ensure the complete dataset is available for export
  await ensureCompleteDatasetIsLoaded();
  let fullDatasetDoramas = completeDoramaDataset;


  const highlightedDoramas = fullDatasetDoramas.filter(dorama =>
    highlightedIds.includes(String(dorama.doramaInfoId))
  );

  if (highlightedDoramas.length === 0) {
    await showAlert("匯出錯誤", "找不到已標記日劇資料");
    return;
  }

  // Group by release year and sort
  const groupedByYear = highlightedDoramas.reduce((acc, dorama) => {
    const year = dorama.releaseYear;
    if (!acc[year]) acc[year] = [];
    acc[year].push(dorama);
    return acc;
  }, {});

  // Sort years in descending order
  const sortedYears = Object.keys(groupedByYear).sort((a, b) => b - a);

  // Create CSV content
  let csvContent = "年份,中文劇名,日文劇名,主演,劇集ID\n";

  sortedYears.forEach(year => {
    groupedByYear[year].forEach(dorama => {
      // Join multiple actors with semicolon
      const actorsString = dorama.mainActor.join(";");

      // Escape quotes and wrap fields that contain commas or quotes in double quotes
      const escapeCSVField = (field) => {
        if (typeof field !== 'string') field = String(field);
        if (field.includes('"')) {
          field = field.replace(/"/g, '""');
        }
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          field = '"' + field + '"';
        }
        return field;
      };

      csvContent += `${escapeCSVField(year)},${escapeCSVField(dorama.chineseTitle)},${escapeCSVField(dorama.japaneseTitle)},${escapeCSVField(actorsString)},${escapeCSVField(dorama.doramaInfoId)}\n`;
    });
  });

  // Create and download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `dodorama_highlighted_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

        // Show success message
  const shareStatus = document.getElementById("share-status");
  if (shareStatus) {
    const message = `已成功匯出 ${highlightedDoramas.length} 部標記的日劇為 CSV`;

    shareStatus.textContent = message;
    setTimeout(() => {
      shareStatus.textContent = "";
    }, 4000);
  }
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = false;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
    i++;
  }

  result.push(current.trim());
  return result;
}

async function validateCSVContent(csvText) {
  const lines = csvText.trim().split('\n').filter(line => line.trim());

  if (lines.length < 2) {
    return { valid: false, error: "CSV 檔案必須包含標題行和至少一行資料" };
  }

  // Check header
  const expectedHeaders = ["年份", "中文劇名", "日文劇名", "主演", "劇集ID"];
  const headers = parseCSVLine(lines[0]);

  if (headers.length !== expectedHeaders.length) {
    return { valid: false, error: `CSV 標題行應包含 ${expectedHeaders.length} 個欄位，實際包含 ${headers.length} 個` };
  }

  for (let i = 0; i < expectedHeaders.length; i++) {
    if (headers[i] !== expectedHeaders[i]) {
      return { valid: false, error: `第 ${i + 1} 個欄位應為 "${expectedHeaders[i]}"，實際為 "${headers[i]}"` };
    }
  }

  // Ensure complete dataset is available for validation
  await ensureCompleteDatasetIsLoaded();
  const fullDatasetDoramas = completeDoramaDataset;


  const validDoramaIds = new Set(fullDatasetDoramas.map(d => String(d.doramaInfoId)));
  const importedIds = [];
  let validCount = 0;
  let invalidRows = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fields = parseCSVLine(line);

    if (fields.length !== expectedHeaders.length) {
      invalidRows.push(`第 ${lineIndex + 1} 行: 欄位數量不正確 (${fields.length}/${expectedHeaders.length})`);
      continue;
    }

    const [year, chineseTitle, japaneseTitle, actors, doramaId] = fields;

    // Validate year
    const yearNum = parseInt(year);
    if (isNaN(yearNum) || yearNum < 1900 || yearNum > new Date().getFullYear() + 10) {
      invalidRows.push(`第 ${lineIndex + 1} 行: 年份無效 "${year}"`);
      continue;
    }

    // Validate dorama ID exists in current dataset
    if (!validDoramaIds.has(String(doramaId))) {
      invalidRows.push(`第 ${lineIndex + 1} 行: 劇集ID "${doramaId}" 在當前資料集中不存在`);
      continue;
    }

    // Check for duplicates in CSV
    if (importedIds.includes(String(doramaId))) {
      invalidRows.push(`第 ${lineIndex + 1} 行: 劇集ID "${doramaId}" 重複`);
      continue;
    }

    importedIds.push(String(doramaId));
    validCount++;
  }

  if (invalidRows.length > 0 && validCount === 0) {
    return {
      valid: false,
      error: "沒有有效的資料行:\n" + invalidRows.slice(0, 5).join("\n") +
             (invalidRows.length > 5 ? `\n...還有 ${invalidRows.length - 5} 個錯誤` : "")
    };
  }

  // Get actual dorama data for valid IDs
  const importedDoramas = fullDatasetDoramas.filter(dorama =>
    importedIds.includes(String(dorama.doramaInfoId))
  );

  return {
    valid: true,
    importedIds,
    importedDoramas,
    validCount,
    invalidCount: invalidRows.length,
    invalidRows: invalidRows.slice(0, 10) // Only return first 10 for display
  };
}

function importHighlightedDoramasFromCSV(file) {
  const reader = new FileReader();

  reader.onload = async function(e) {
    try {
      const csvText = e.target.result;
      const validation = await validateCSVContent(csvText);

      if (!validation.valid) {
        await showAlert("CSV 檔案格式錯誤", validation.error);
        return;
      }

      // Show preview dialog first - even if there are validation errors
      if (validation.validCount > 0) {
        const shouldProceed = await showImportPreviewDialog(
          validation.importedDoramas,
          validation.invalidCount,
          validation.invalidRows
        );

        if (!shouldProceed) {
          return; // User cancelled after seeing preview
        }
      } else {
        // No valid doramas to import
        await showAlert("CSV 檔案無有效資料",
          "CSV 檔案中沒有可匯入的有效日劇資料。\n\n" +
          validation.invalidRows.slice(0, 5).join('\n') +
          (validation.invalidRows.length > 5 ? `\n...還有 ${validation.invalidRows.length - 5} 個錯誤` : "")
        );
        return;
      }

      // Import valid doramas
      if (validation.validCount > 0) {
        const existingHighlightedIds = JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];
        const hasExistingHighlights = existingHighlightedIds.length > 0;

        let finalHighlightedIds;
        let importMode = "overwrite"; // default

        if (hasExistingHighlights) {
          // Show choice dialog using custom modal
          const choice = await showImportChoiceDialog(existingHighlightedIds.length, validation.importedDoramas.length);
          if (choice === null) {
            return; // User cancelled
          }
          importMode = choice;
        }

        if (importMode === "merge") {
          // Merge: combine existing and new highlights, avoiding duplicates
          const mergedIds = [...new Set([...existingHighlightedIds, ...validation.importedIds])];
          finalHighlightedIds = mergedIds;
        } else {
          // Overwrite: replace all existing highlights with new ones
          finalHighlightedIds = validation.importedIds;
        }

        localStorage.setItem("highlightedDoramaIds", JSON.stringify(finalHighlightedIds));

        // Clear all existing highlights and apply final set
        const highlightedCards = document.querySelectorAll(".dorama-card.highlighted");
        highlightedCards.forEach(card => card.classList.remove("highlighted"));

        // Apply final highlights
        finalHighlightedIds.forEach(id => {
          const card = document.querySelector(`.dorama-card[data-dorama-id='${id}']`);
          if (card) card.classList.add("highlighted");
        });

        updateShareButtonState();
        updateActiveFilterDisplay(); // Update highlight count display

        const shareStatus = document.getElementById("share-status");
        if (shareStatus) {
          let message;
          if (importMode === "merge") {
            const addedCount = finalHighlightedIds.length - existingHighlightedIds.length;
            message = validation.invalidCount > 0
              ? `已合併 ${validation.validCount} 部日劇 (新增 ${addedCount} 部)，${validation.invalidCount} 部無效`
              : `已成功合併 ${validation.validCount} 部日劇 (新增 ${addedCount} 部)`;
          } else {
            message = validation.invalidCount > 0
              ? `已覆寫匯入 ${validation.validCount} 部日劇，${validation.invalidCount} 部無效`
              : `已成功覆寫匯入 ${validation.validCount} 部日劇`;
          }
          shareStatus.textContent = message;
          setTimeout(() => {
            shareStatus.textContent = "";
          }, 4000);
        }
      }
    } catch (error) {
      console.error("Import error:", error);
      await showAlert("CSV 匯入錯誤", "匯入 CSV 檔案時發生錯誤: " + error.message);
    }
  };

  reader.onerror = async function() {
    await showAlert("讀取錯誤", "讀取 CSV 檔案時發生錯誤");
  };

  reader.readAsText(file, 'utf-8');
}

async function showImportPreviewDialog(importedDoramas, invalidCount, invalidRows) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-dialog-modal");
    const titleEl = document.getElementById("dialog-title");
    const messageEl = document.getElementById("dialog-message");
    const buttonsContainer = document.getElementById("dialog-buttons");
    const closeBtn = document.getElementById("dialog-close-btn");

    titleEl.textContent = "匯入預覽";

    // Get existing highlighted IDs
    const existingHighlightedIds = new Set(JSON.parse(localStorage.getItem("highlightedDoramaIds")) || []);

    // Separate new and existing doramas
    const newDoramas = importedDoramas.filter(dorama =>
      !existingHighlightedIds.has(String(dorama.doramaInfoId))
    );
    const existingDoramas = importedDoramas.filter(dorama =>
      existingHighlightedIds.has(String(dorama.doramaInfoId))
    );

    // Create preview content
    let content = `即將匯入 ${importedDoramas.length} 部日劇\n`;
    content += `├ 新增：${newDoramas.length} 部\n`;
    content += `└ 已標記：${existingDoramas.length} 部\n\n`;

    if (newDoramas.length > 0) {
      content += `🆕 新增日劇 (${newDoramas.length} 部)：\n`;

      // Group new doramas by year
      const newGroupedByYear = newDoramas.reduce((acc, dorama) => {
        const year = dorama.releaseYear;
        if (!acc[year]) acc[year] = [];
        acc[year].push(dorama);
        return acc;
      }, {});

      const newSortedYears = Object.keys(newGroupedByYear).sort((a, b) => b - a);

      newSortedYears.forEach(year => {
        content += `【${year}年】\n`;
        newGroupedByYear[year].forEach(dorama => {
          content += `  • ${dorama.chineseTitle}\n`;
        });
      });
      content += `\n`;
    }

    if (existingDoramas.length > 0) {
      content += `✅ 已標記日劇 (${existingDoramas.length} 部)：\n`;

      // Group existing doramas by year
      const existingGroupedByYear = existingDoramas.reduce((acc, dorama) => {
        const year = dorama.releaseYear;
        if (!acc[year]) acc[year] = [];
        acc[year].push(dorama);
        return acc;
      }, {});

      const existingSortedYears = Object.keys(existingGroupedByYear).sort((a, b) => b - a);

      existingSortedYears.forEach(year => {
        content += `【${year}年】\n`;
        existingGroupedByYear[year].forEach(dorama => {
          content += `  • ${dorama.chineseTitle}\n`;
        });
      });
      content += `\n`;
    }

    if (invalidCount > 0) {
      content += `⚠️ ${invalidCount} 行資料無效，將被跳過\n`;
      if (invalidRows.length > 0) {
        content += `\n錯誤詳情：\n${invalidRows.slice(0, 3).join('\n')}`;
        if (invalidRows.length > 3) {
          content += `\n...還有 ${invalidRows.length - 3} 個錯誤`;
        }
      }
    }

    messageEl.textContent = content;

    // Clear previous buttons
    buttonsContainer.innerHTML = '';

    // Add buttons
    const buttons = [
      { text: "確認匯入", value: true, class: "dialog-btn-primary" },
      { text: "取消", value: false, class: "dialog-btn-light" }
    ];

    buttons.forEach((button, index) => {
      const btn = document.createElement("button");
      btn.textContent = button.text;
      btn.className = `dialog-btn ${button.class}`;
      btn.onclick = () => {
        closeDialog();
        resolve(button.value);
      };
      buttonsContainer.appendChild(btn);

      // Auto-focus first button
      if (index === 0) {
        setTimeout(() => btn.focus(), 100);
      }
    });

    // Close button
    closeBtn.onclick = () => {
      closeDialog();
      resolve(false);
    };

    // Close on escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeDialog();
        resolve(false);
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Close on backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) {
        closeDialog();
        resolve(false);
      }
    };

    function closeDialog() {
      modal.style.display = "none";
      document.body.classList.remove("modal-open");
      document.removeEventListener('keydown', handleEscape);
    }

    // Show modal
    modal.style.display = "flex";
    document.body.classList.add("modal-open");
  });
}

async function showImportChoiceDialog(existingCount, newCount) {
  const message = `目前已標記 ${existingCount} 部日劇，即將匯入 ${newCount} 部日劇。\n\n請選擇匯入方式：`;

  const choice = await showCustomDialog("選擇匯入方式", message, [
    {
      text: "🔄 覆寫",
      value: "overwrite",
      class: "dialog-btn-danger",
      title: "清除現有標記，只保留匯入的日劇"
    },
    {
      text: "🔗 合併",
      value: "merge",
      class: "dialog-btn-secondary",
      title: "保留現有標記，加入匯入的日劇"
    },
    {
      text: "取消",
      value: null,
      class: "dialog-btn-light"
    }
  ]);

  return choice;
}

// --- Image Generation Helper Functions ---
function generateActorChecklistImage(actorName, doramas, highlightedIds) {
  const actorDoramas = doramas.filter((d) => d.mainActor.includes(actorName));
  const imageContainer = document.createElement("div");
  Object.assign(imageContainer.style, {
    position: "absolute",
    left: "-9999px",
    width: "1200px",
    padding: "40px",
    backgroundColor: "#ffffff",
    fontFamily: "sans-serif",
    border: "1px solid #ddd",
  });
  let contentHtml = `<h2 style="text-align: center; color: #333; font-size: 48px; font-weight: 700; margin: 0 0 30px 0;">${actorName} 的日劇清單</h2>`;

  // Calculate number of columns (6 per row)
  const columnsPerRow = 6;
  const rows = Math.ceil(actorDoramas.length / columnsPerRow);

  contentHtml += `<table style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px;">`;

  for (let row = 0; row < rows; row++) {
    contentHtml += `<tr style="height: 80px;">`;
    for (let col = 0; col < columnsPerRow; col++) {
      const index = row * columnsPerRow + col;
      if (index < actorDoramas.length) {
        const dorama = actorDoramas[index];
        const isSeen = highlightedIds.has(String(dorama.doramaInfoId));
        const seenStyle = `background-color: #10b981; color: white; border: 1px solid #059669; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);`;
        const unseenStyle = `background-color: #f8fafc; color: #475569; border: 1px solid #e2e8f0;`;
        const cellStyle = `width: ${100 / columnsPerRow}%; padding: 10px 6px; font-size: 18px; font-weight: 600; border-radius: 5px; text-align: center; vertical-align: middle; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; ${isSeen ? seenStyle : unseenStyle}`;
        contentHtml += `<td style="${cellStyle}">${dorama.chineseTitle} (${dorama.releaseYear})</td>`;
      } else {
        contentHtml += `<td style="width: ${100 / columnsPerRow}%;"></td>`;
      }
    }
    contentHtml += `</tr>`;
  }

  contentHtml += `</table><p style="text-align: right; margin-top: 25px; font-size: 18px; font-weight: 600; color: #999;">由 dodorama 產生</p>`;
  imageContainer.innerHTML = contentHtml;
  return imageContainer;
}

function generateDataSourceChecklistImage(
  doramas,
  highlightedIds,
  title,
  gridColumns = 10,
  showCheckmarks = true,
) {
  const imageContainer = document.createElement("div");
  Object.assign(imageContainer.style, {
    position: "absolute",
    left: "-9999px",
    width: "1200px",
    padding: "40px",
    backgroundColor: "#ffffff",
    fontFamily: "sans-serif",
    border: "1px solid #ddd",
  });
  let gridHtml = `<h2 style="text-align: center; color: #333; font-size: 48px; font-weight: 700; margin: 0 0 30px 0;">${title}</h2>`;

  // Calculate rows and columns for table layout
  const rows = Math.ceil(doramas.length / gridColumns);

  gridHtml += `<table style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px;">`;

  for (let row = 0; row < rows; row++) {
    gridHtml += `<tr style="height: 70px;">`;
    for (let col = 0; col < gridColumns; col++) {
      const index = row * gridColumns + col;
      if (index < doramas.length) {
        const dorama = doramas[index];
        const isSeen = highlightedIds.has(String(dorama.doramaInfoId));
        const seenStyle = `background-color: #10b981; color: white; border: 1px solid #059669; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);`;
        const unseenStyle = `background-color: #f8fafc; color: #475569; border: 1px solid #e2e8f0;`;
        const cellStyle = `width: ${100 / gridColumns}%; padding: 8px 4px; font-size: 16px; font-weight: 600; border-radius: 5px; text-align: center; vertical-align: middle; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; ${isSeen ? seenStyle : unseenStyle}`;
        gridHtml += `<td style="${cellStyle}">${dorama.chineseTitle}</td>`;
      } else {
        gridHtml += `<td style="width: ${100 / gridColumns}%;"></td>`;
      }
    }
    gridHtml += `</tr>`;
  }

  gridHtml += `</table><p style="text-align: right; margin-top: 25px; font-size: 18px; font-weight: 600; color: #999;">由 dodorama 產生</p>`;
  imageContainer.innerHTML = gridHtml;
  return imageContainer;
}

function generateTop5PerYearChecklistImage(doramas, highlightedIds, title) {
  const imageContainer = document.createElement("div");
  Object.assign(imageContainer.style, {
    position: "absolute",
    left: "-9999px",
    width: "1200px",
    padding: "40px",
    backgroundColor: "#ffffff",
    fontFamily: "sans-serif",
    border: "1px solid #ddd",
  });

  // Group doramas by year
  const groupedByYear = doramas.reduce((acc, dorama) => {
    const year = dorama.releaseYear;
    if (!acc[year]) acc[year] = [];
    acc[year].push(dorama);
    return acc;
  }, {});

  const sortedYears = Object.keys(groupedByYear).sort((a, b) => b - a);

  // Determine if this is Top 5 data (max 5 per year) or general data
  const maxDoramasPerYear = Math.max(...Object.values(groupedByYear).map(arr => arr.length));
  const isTop5Data = maxDoramasPerYear <= 5;
  const doramasPerRow = isTop5Data ? 5 : 6; // Use 5 columns for Top 5, 6 for general data

  let contentHtml = `<h2 style="text-align: center; color: #333; font-size: 48px; font-weight: 700; margin: 0 0 30px 0;">${title}</h2>`;

  contentHtml += `<table style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px;">`;

  sortedYears.forEach((year) => {
    const yearDoramas = groupedByYear[year];
    const rows = Math.ceil(yearDoramas.length / doramasPerRow);

    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      contentHtml += `<tr style="height: 80px;">`;

      // Year header only on the first row for this year
      if (rowIndex === 0) {
        const yearCellStyle = `width: 120px; padding: 10px 8px; font-size: 20px; font-weight: 700; border-radius: 5px; text-align: center; vertical-align: middle; background-color: #64748b; color: white; border: 1px solid #475569; ${rows > 1 ? 'vertical-align: top; padding-top: 25px;' : ''}`;
        contentHtml += `<td rowspan="${rows}" style="${yearCellStyle}">${year}</td>`;
      }

      // Doramas for this row
      const startIndex = rowIndex * doramasPerRow;
      const endIndex = Math.min(startIndex + doramasPerRow, yearDoramas.length);
      const doramaColumnWidth = (100 - 12) / doramasPerRow; // 12% for year column, remaining divided by doramasPerRow

      for (let i = startIndex; i < endIndex; i++) {
        const dorama = yearDoramas[i];
        const isSeen = highlightedIds.has(String(dorama.doramaInfoId));
        const seenStyle = `background-color: #10b981; color: white; border: 1px solid #059669; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);`;
        const unseenStyle = `background-color: #f8fafc; color: #475569; border: 1px solid #e2e8f0;`;
        const cellStyle = `width: ${doramaColumnWidth}%; padding: 10px 8px; font-size: 17px; font-weight: 600; border-radius: 5px; text-align: center; vertical-align: middle; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; ${isSeen ? seenStyle : unseenStyle}`;
        contentHtml += `<td style="${cellStyle}">${dorama.chineseTitle}</td>`;
      }

      // Fill empty cells if less than doramasPerRow doramas in this row
      for (let i = endIndex - startIndex; i < doramasPerRow; i++) {
        contentHtml += `<td style="width: ${doramaColumnWidth}%;"></td>`;
      }

      contentHtml += `</tr>`;
    }
  });

  contentHtml += `</table><p style="text-align: right; margin-top: 25px; font-size: 18px; font-weight: 600; color: #999;">由 dodorama 產生</p>`;
  imageContainer.innerHTML = contentHtml;
  return imageContainer;
}

// --- UI Update and Display Functions ---
function displayDoramaGrid(doramas) {
  const mainGridContainer = document.getElementById("dorama-grid");
  const statusDiv = document.getElementById("status-message");
  mainGridContainer.innerHTML = "";

  // Reset displayed count when new data is loaded
  displayedCountPerYear = {};

  if (!doramas || doramas.length === 0) {
    mainGridContainer.innerHTML = "<p>找不到相符的資料</p>";
    statusDiv.textContent = "沒有結果";
    return;
  }

  statusDiv.textContent = `顯示 ${doramas.length} 項結果`;
  const groupedByYear = doramas.reduce((acc, dorama) => {
    const year = dorama.releaseYear;
    if (!acc[year]) acc[year] = [];
    acc[year].push(dorama);
    return acc;
  }, {});

  const sortedYears = Object.keys(groupedByYear).sort((a, b) => b - a);

  sortedYears.forEach((year) => {
    const yearHeading = document.createElement("h2");
    yearHeading.className = "year-heading";
    yearHeading.textContent = year;
    mainGridContainer.appendChild(yearHeading);

    const yearContainer = document.createElement("div");
    yearContainer.className = "year-container";
    yearContainer.dataset.year = year;

    const yearGrid = document.createElement("div");
    yearGrid.className = "grid-container";
    yearGrid.dataset.year = year;

    // Initialize displayed count for this year
    displayedCountPerYear[year] = Math.min(6, groupedByYear[year].length);

    // Show initial 6 doramas (or less if there are fewer than 6)
    renderDoramasForYear(
      yearGrid,
      groupedByYear[year],
      0,
      displayedCountPerYear[year],
    );

    yearContainer.appendChild(yearGrid);

    const loadMoreButton = createLoadMoreButton(year, groupedByYear[year]);
    yearContainer.appendChild(loadMoreButton);

    mainGridContainer.appendChild(yearContainer);
  });

  const applyPersistedHighlights = () => {
    const highlightedIds =
      JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];
    highlightedIds.forEach((id) => {
      const cardToHighlight = document.querySelector(
        `.dorama-card[data-dorama-id='${id}']`,
      );
      if (cardToHighlight) cardToHighlight.classList.add("highlighted");
    });
  };
  applyPersistedHighlights();
}

function renderDoramasForYear(yearGrid, doramas, startIndex, endIndex) {
  for (let i = startIndex; i < endIndex; i++) {
    const dorama = doramas[i];
    const card = document.createElement("div");
    card.className = "dorama-card";
    card.dataset.doramaId = dorama.doramaInfoId;
    const actorsHtml = dorama.mainActor
      .map((actor) => `<li>${actor}</li>`)
      .join("");
    card.innerHTML = `<h3>${dorama.chineseTitle}</h3><p class="secondary-title">${dorama.japaneseTitle}</p><ul class="actors-list">${actorsHtml}</ul>`;
    card.addEventListener("click", (event) => {
      if (event.target.tagName === "LI") return;
      const isNowHighlighted = card.classList.toggle("highlighted");
      updatePersistedHighlights(card.dataset.doramaId, isNowHighlighted);
      updateShareButtonState(); // Update share button when highlighting changes
      updateActiveFilterDisplay(); // Update highlight count display
    });
    yearGrid.appendChild(card);
  }
}

function createLoadMoreButton(year, yearDoramas) {
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "load-more-container";
  buttonContainer.style.cssText =
    "text-align: center; margin: 20px 0; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;";

  const loadMoreButton = document.createElement("button");
  loadMoreButton.className = "load-more-btn";
  loadMoreButton.style.cssText = `
    background-color: #007bff;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s;
  `;

  const loadAllButton = document.createElement("button");
  loadAllButton.className = "load-all-btn";
  loadAllButton.style.cssText = `
    background-color: #28a745;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s;
  `;

  updateLoadMoreButtonText(loadMoreButton, year, yearDoramas.length);
  updateLoadAllButtonText(loadAllButton, year, yearDoramas.length);

  loadMoreButton.addEventListener("click", () => {
    loadMoreForYear(year, yearDoramas, loadMoreButton, loadAllButton);
  });

  loadAllButton.addEventListener("click", () => {
    loadAllForYear(year, yearDoramas, loadMoreButton, loadAllButton);
  });

  loadMoreButton.addEventListener("mouseenter", () => {
    if (displayedCountPerYear[year] < yearDoramas.length) {
      loadMoreButton.style.backgroundColor = "#0056b3";
    }
  });

  loadMoreButton.addEventListener("mouseleave", () => {
    if (displayedCountPerYear[year] < yearDoramas.length) {
      loadMoreButton.style.backgroundColor = "#007bff";
    }
  });

  loadAllButton.addEventListener("mouseenter", () => {
    loadAllButton.style.backgroundColor = "#218838";
  });

  loadAllButton.addEventListener("mouseleave", () => {
    loadAllButton.style.backgroundColor = "#28a745";
  });

  buttonContainer.appendChild(loadMoreButton);
  buttonContainer.appendChild(loadAllButton);
  return buttonContainer;
}

function updateLoadMoreButtonText(button, year, totalCount) {
  const currentlyDisplayed = displayedCountPerYear[year];
  const remaining = totalCount - currentlyDisplayed;

  if (remaining <= 0) {
    button.textContent = "已顯示全部";
    button.disabled = true;
    button.style.backgroundColor = "#6c757d";
    button.style.cursor = "not-allowed";
  } else if (remaining <= 10) {
    button.textContent = `載入剩餘 ${remaining} 部`;
  } else {
    button.textContent = `載入更多 (再顯示 10 部)`;
  }
}

function updateLoadAllButtonText(button, year, totalCount) {
  const currentlyDisplayed = displayedCountPerYear[year];
  const remaining = totalCount - currentlyDisplayed;

  if (remaining <= 0) {
    button.style.display = "none";
  } else {
    button.textContent = `載入全部 (${remaining} 部)`;
    button.disabled = false;
    button.style.backgroundColor = "#28a745";
    button.style.cursor = "pointer";
  }
}

function loadMoreForYear(year, yearDoramas, loadMoreButton, loadAllButton) {
  const yearGrid = document.querySelector(
    `.grid-container[data-year="${year}"]`,
  );
  if (!yearGrid) return;

  const currentlyDisplayed = displayedCountPerYear[year];
  const totalCount = yearDoramas.length;
  const remaining = totalCount - currentlyDisplayed;

  if (remaining <= 0) return;

  // Load 10 more or all remaining if less than 10
  const toLoad = Math.min(10, remaining);
  const newDisplayCount = currentlyDisplayed + toLoad;

  // Render the new doramas
  renderDoramasForYear(
    yearGrid,
    yearDoramas,
    currentlyDisplayed,
    newDisplayCount,
  );

  // Update the displayed count
  displayedCountPerYear[year] = newDisplayCount;

  // Update both button texts
  updateLoadMoreButtonText(loadMoreButton, year, totalCount);
  updateLoadAllButtonText(loadAllButton, year, totalCount);

  // Reapply highlights to new cards
  reapplyHighlights();
}

function loadAllForYear(year, yearDoramas, loadMoreButton, loadAllButton) {
  const yearGrid = document.querySelector(
    `.grid-container[data-year="${year}"]`,
  );
  if (!yearGrid) return;

  const currentlyDisplayed = displayedCountPerYear[year];
  const totalCount = yearDoramas.length;
  const remaining = totalCount - currentlyDisplayed;

  if (remaining <= 0) return;

  // Load all remaining doramas
  const newDisplayCount = totalCount;

  // Render all remaining doramas
  renderDoramasForYear(
    yearGrid,
    yearDoramas,
    currentlyDisplayed,
    newDisplayCount,
  );

  // Update the displayed count
  displayedCountPerYear[year] = newDisplayCount;

  // Update both button texts
  updateLoadMoreButtonText(loadMoreButton, year, totalCount);
  updateLoadAllButtonText(loadAllButton, year, totalCount);

  // Reapply highlights to new cards
  reapplyHighlights();
}

function reapplyHighlights() {
  const highlightedIds =
    JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [];
  highlightedIds.forEach((id) => {
    const cardToHighlight = document.querySelector(
      `.dorama-card[data-dorama-id='${id}']`,
    );
    if (cardToHighlight) cardToHighlight.classList.add("highlighted");
  });
}

function updateActiveFilterDisplay() {
  const container = document.getElementById("active-filter-display");
  if (!container) return;

  let filtersHtml = "";

  // Add dataset and highlights info
  const highlightedIds = JSON.parse(localStorage.getItem("highlightedDoramaIds") || "[]");
  const dataSourceNames = {
    "dorama_info.txtpb": "全部日劇",
    "top_100_dorama_info.txtpb": "Top 100 總榜",
    "top_5_lt_2000_dorama_info.txtpb": "每年 Top 5 (2000年前)",
    "top_5_ge_2000_dorama_info.txtpb": "每年 Top 5 (2000年起)",
  };

  const currentDatasetName = dataSourceNames[currentDataSourceFile] || "未知資料集";

    if (highlightedIds.length > 0) {
    filtersHtml += `
      <span class="active-filter-pill dataset-info">
        📊 ${currentDatasetName} | 📋 已標記 ${highlightedIds.length} 部
      </span>
    `;
  } else {
    filtersHtml += `
      <span class="active-filter-pill dataset-info">
        📊 ${currentDatasetName}
      </span>
    `;
  }

  if (searchTerm) {
    filtersHtml += `
      <span class="active-filter-pill">
        搜尋: <strong>${searchTerm}</strong>
        <button class="clear-search-btn" title="清除搜尋">×</button>
      </span>
    `;
  }

  if (activeActorFilter) {
    filtersHtml += `
      <span class="active-filter-pill">
        篩選主演: <strong>${activeActorFilter}</strong>
                  <button class="clear-filter-btn" title="清除主演篩選">×</button>
      </span>
    `;
  }

  if (filtersHtml) {
    container.style.display = "block";
    container.innerHTML = filtersHtml;

    // Add event listeners for clear buttons
    const clearSearchBtn = container.querySelector(".clear-search-btn");
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        const searchInput = document.getElementById("search-input");
        searchInput.value = "";
        searchTerm = "";
        applyAllFilters();
      });
    }

    const clearFilterBtn = container.querySelector(".clear-filter-btn");
    if (clearFilterBtn) {
      clearFilterBtn.addEventListener("click", () => {
        activeActorFilter = "";
        localStorage.removeItem("activeActorFilter");
        applyAllFilters();
      });
    }
  } else {
    container.style.display = "none";
    container.innerHTML = "";
  }

  // Update top padding after filter display changes
  updateBodyTopPadding();
}

function updateShareButtonState() {
  const shareButton = document.getElementById("share-button");
  const exportCSVButton = document.getElementById("export-csv-btn");
  const importCSVLabel = document.getElementById("import-csv-label");

  if (!shareButton) return;

  const isSpecialDataSource = currentDataSourceFile !== "dorama_info.txtpb";
  const highlightedIds = JSON.parse(
    localStorage.getItem("highlightedDoramaIds") || "[]",
  );
  const hasHighlightedDoramas = highlightedIds.length > 0;

  // Update share button
  if (
    isSpecialDataSource ||
    (currentDataSourceFile === "dorama_info.txtpb" && hasHighlightedDoramas)
  ) {
    shareButton.disabled = false;
    if (
      currentDataSourceFile === "dorama_info.txtpb" &&
      hasHighlightedDoramas
    ) {
      shareButton.title = `產生已標記日劇觀看清單圖片 (${highlightedIds.length} 部)`;
    } else {
      const dataSourceNames = {
        "top_100_dorama_info.txtpb": "Top 100 總榜",
        "top_5_lt_2000_dorama_info.txtpb": "每年 Top 5 (2000年前)",
        "top_5_ge_2000_dorama_info.txtpb": "每年 Top 5 (2000年起)",
      };
      shareButton.title = `產生 ${dataSourceNames[currentDataSourceFile] || "觀看清單"} 圖片`;
    }
  } else {
    shareButton.disabled = true;
    shareButton.title = "請選擇特定資料集，或標記一些日劇";
  }

      // Update CSV buttons - they work with ALL highlights globally
  if (exportCSVButton) {
    if (hasHighlightedDoramas) {
      exportCSVButton.disabled = false;
      exportCSVButton.title = `匯出 ${highlightedIds.length} 部已標記日劇為 CSV`;
    } else {
      exportCSVButton.disabled = true;
      exportCSVButton.title = "沒有已標記日劇可以匯出為 CSV";
    }
  }

  if (importCSVLabel) {
    importCSVLabel.title = "從 CSV 檔案匯入已標記日劇";
  }
}

// --- Initialization, Filtering, and Event Listeners ---

// Global function to update body top padding based on header height
function updateBodyTopPadding() {
  const header = document.querySelector("header");
  if (!header) return;

  const headerHeight = header.offsetHeight;
  document.body.style.paddingTop = `${headerHeight}px`;
}

function setupResponsiveHeader() {
  const header = document.querySelector("header");
  const mainContent = document.getElementById("main-content");
  const filterToggleBtn = document.getElementById("filter-toggle-btn");
  const filterMenuContainer = document.getElementById("filter-menu-container");
  const menuToggleBtn = document.getElementById("menu-toggle-btn");
  const filtersContainer = document.getElementById("filters-container");

  if (!header || !mainContent) return;

  const updateTopPadding = updateBodyTopPadding;

  // Initial setup on load and on resize
  updateTopPadding();
  window.addEventListener("resize", updateTopPadding);

  // Handle filter menu toggle on mobile (left button)
  if (filterToggleBtn && filterMenuContainer) {
    filterToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isExpanded =
        filterToggleBtn.getAttribute("aria-expanded") === "true";
      filterToggleBtn.setAttribute("aria-expanded", !isExpanded);
      header.classList.toggle("filter-menu-open");

      // Close the other menu if it's open
      if (header.classList.contains("filters-open")) {
        header.classList.remove("filters-open");
        if (menuToggleBtn) menuToggleBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Handle filter confirm button
    const filterConfirmBtn = document.getElementById("filter-confirm-button");
    if (filterConfirmBtn) {
      filterConfirmBtn.addEventListener("click", () => {
        header.classList.remove("filter-menu-open");
        filterToggleBtn.setAttribute("aria-expanded", "false");
      });
    }

    // Prevent menu from closing when clicking inside the filter menu container
    filterMenuContainer.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Update padding after CSS transition
    filterMenuContainer.addEventListener("transitionend", (event) => {
      if (
        event.propertyName === "transform" ||
        event.propertyName === "opacity"
      ) {
        updateTopPadding();
      }
    });
  }

  // Handle main menu toggle on mobile (right button)
  if (menuToggleBtn && filtersContainer) {
    menuToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isExpanded = menuToggleBtn.getAttribute("aria-expanded") === "true";
      menuToggleBtn.setAttribute("aria-expanded", !isExpanded);
      header.classList.toggle("filters-open");

      // Close the other menu if it's open
      if (header.classList.contains("filter-menu-open")) {
        header.classList.remove("filter-menu-open");
        if (filterToggleBtn)
          filterToggleBtn.setAttribute("aria-expanded", "false");
      }
    });

    // Prevent menu from closing when clicking inside the filters container
    filtersContainer.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Update padding after CSS transition
    filtersContainer.addEventListener("transitionend", (event) => {
      if (
        event.propertyName === "transform" ||
        event.propertyName === "opacity"
      ) {
        updateTopPadding();
      }
    });
  }

  // Close menus when clicking outside
  document.addEventListener("click", (e) => {
    if (window.innerWidth <= 960) {
      // Close filter menu if clicking outside of it
      if (header.classList.contains("filter-menu-open")) {
        const isClickInsideFilterMenu =
          filterMenuContainer && filterMenuContainer.contains(e.target);
        const isClickOnFilterButton =
          filterToggleBtn && filterToggleBtn.contains(e.target);

        if (!isClickInsideFilterMenu && !isClickOnFilterButton) {
          header.classList.remove("filter-menu-open");
          if (filterToggleBtn)
            filterToggleBtn.setAttribute("aria-expanded", "false");
        }
      }

      // Close main menu if clicking outside of it
      if (header.classList.contains("filters-open")) {
        const isClickInsideMainMenu =
          filtersContainer && filtersContainer.contains(e.target);
        const isClickOnMenuButton =
          menuToggleBtn && menuToggleBtn.contains(e.target);

        if (!isClickInsideMainMenu && !isClickOnMenuButton) {
          header.classList.remove("filters-open");
          if (menuToggleBtn)
            menuToggleBtn.setAttribute("aria-expanded", "false");
        }
      }
    }
  });

  // Close menus on escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (header.classList.contains("filter-menu-open")) {
        header.classList.remove("filter-menu-open");
        if (filterToggleBtn)
          filterToggleBtn.setAttribute("aria-expanded", "false");
      }
      if (header.classList.contains("filters-open")) {
        header.classList.remove("filter-menu-open");
        if (menuToggleBtn)
          menuToggleBtn.setAttribute("aria-expanded", "false");
      }
    }
  });
}

function initializeActorToggle() {
  const actorsToggle = document.getElementById("actors-toggle");
  const mainContainer = document.getElementById("main-content");
  if (!actorsToggle || !mainContainer) return;
  const shouldShowActors = localStorage.getItem("showActors") !== "false";
  actorsToggle.checked = shouldShowActors;
  mainContainer.classList.toggle("actors-hidden", !shouldShowActors);
  actorsToggle.addEventListener("change", () => {
    const isChecked = actorsToggle.checked;
    localStorage.setItem("showActors", isChecked);
    mainContainer.classList.toggle("actors-hidden", !isChecked);
  });
}

function initializeDataSourceDropdown() {
  const dropdown = document.getElementById("data-source-dropdown");
  if (!dropdown) return;
  dropdown.value = currentDataSourceFile;
  dropdown.addEventListener("change", () => {
    const newDataSourceFile = dropdown.value;
    localStorage.setItem("selectedDataSource", newDataSourceFile);

    if (newDataSourceFile !== currentDataSourceFile) {
      currentDataSourceFile = newDataSourceFile;
      // Keep the actor filter when switching data sources
      loadDoramaInfo(currentDataSourceFile);
      // Update display immediately to show new dataset name
      updateActiveFilterDisplay();
    }
  });
}

function populateYearDropdowns() {
  if (!allDoramas || allDoramas.length === 0) return;

  const startYearSelect = document.getElementById("start-year-input");
  const endYearSelect = document.getElementById("end-year-input");

  // Get unique years from all doramas and sort them
  const years = [
    ...new Set(allDoramas.map((dorama) => dorama.releaseYear)),
  ].sort((a, b) => a - b);

  // Clear existing options except the first placeholder
  startYearSelect.innerHTML = '<option value="">起始年份</option>';
  endYearSelect.innerHTML = '<option value="">結束年份</option>';

  // Add year options
  years.forEach((year) => {
    const startOption = document.createElement("option");
    startOption.value = year;
    startOption.textContent = year;
    startYearSelect.appendChild(startOption);

    const endOption = document.createElement("option");
    endOption.value = year;
    endOption.textContent = year;
    endYearSelect.appendChild(endOption);
  });

  // Set end year to current year by default
  const currentYear = new Date().getFullYear();
  endYearSelect.value = currentYear;
}

function applyAllFilters() {
  const startYearInput = document.getElementById("start-year-input");
  const endYearInput = document.getElementById("end-year-input");
  const startYear = parseInt(startYearInput.value, 10);
  const endYear = parseInt(endYearInput.value, 10);
  const hasStart = !isNaN(startYear) && startYearInput.value !== "";
  const hasEnd = !isNaN(endYear) && endYearInput.value !== "";
  let filteredDoramas = allDoramas;

  // Apply year filter
  if (hasStart || hasEnd) {
    filteredDoramas = filteredDoramas.filter((dorama) => {
      const year = dorama.releaseYear;
      if (hasStart && hasEnd) return year >= startYear && year <= endYear;
      if (hasStart) return year >= startYear;
      if (hasEnd) return year <= endYear;
      return true;
    });
  }

  // Apply text search filter
  if (searchTerm) {
    const lowerSearchTerm = searchTerm.toLowerCase();
    filteredDoramas = filteredDoramas.filter((dorama) => {
      // Search in Chinese title
      const chineseTitleMatch = dorama.chineseTitle
        .toLowerCase()
        .includes(lowerSearchTerm);
      // Search in Japanese title
      const japaneseTitleMatch = dorama.japaneseTitle
        .toLowerCase()
        .includes(lowerSearchTerm);
      // Search in main actors
      const actorMatch = dorama.mainActor.some((actor) =>
        actor.toLowerCase().includes(lowerSearchTerm),
      );
      return chineseTitleMatch || japaneseTitleMatch || actorMatch;
    });
  }

  // Apply actor filter (from clicking on actor names)
  if (activeActorFilter) {
    filteredDoramas = filteredDoramas.filter((dorama) =>
      dorama.mainActor.includes(activeActorFilter),
    );
  }

  displayDoramaGrid(filteredDoramas);
  updateActiveFilterDisplay();
  updateShareButtonState();
}

function setupEventListeners() {
  const resetButton = document.getElementById("reset-button");
  const startYearInput = document.getElementById("start-year-input");
  const endYearInput = document.getElementById("end-year-input");
  const searchInput = document.getElementById("search-input");

  startYearInput.addEventListener("change", applyAllFilters);
  endYearInput.addEventListener("change", applyAllFilters);

  // Add search input event listener
  searchInput.addEventListener("input", (event) => {
    searchTerm = event.target.value.trim();
    applyAllFilters();
  });

  resetButton.addEventListener("click", () => {
    startYearInput.value = "";
    const currentYear = new Date().getFullYear();
    endYearInput.value = currentYear;
    searchInput.value = "";
    searchTerm = "";
    activeActorFilter = "";
    localStorage.removeItem("activeActorFilter");
    applyAllFilters();
  });

  const doramaGrid = document.getElementById("dorama-grid");
  doramaGrid.addEventListener("click", (event) => {
    if (
      event.target.tagName === "LI" &&
      event.target.closest("ul.actors-list")
    ) {
      const actorName = event.target.textContent;
      activeActorFilter = actorName;
      localStorage.setItem("activeActorFilter", actorName);
      applyAllFilters();
    }
  });

  const clearHighlightsButton = document.getElementById("clear-highlights-btn");
  if (clearHighlightsButton) {
    clearHighlightsButton.addEventListener("click", () => {
      localStorage.removeItem("highlightedDoramaIds");
      const highlightedCards = document.querySelectorAll(
        ".dorama-card.highlighted",
      );
      highlightedCards.forEach((card) => card.classList.remove("highlighted"));
      const shareStatus = document.getElementById("share-status");
      if (shareStatus) {
        shareStatus.textContent = "已清除所有標記";
        setTimeout(() => {
          shareStatus.textContent = "";
        }, 3000);
      }
      updateShareButtonState(); // Update share button when highlights are cleared
      updateActiveFilterDisplay(); // Update highlight count display
    });
  }

  // CSV Export button
  const exportCSVButton = document.getElementById("export-csv-btn");
  if (exportCSVButton) {
    exportCSVButton.addEventListener("click", () => {
      exportHighlightedDoramasToCSV();
    });
  }

    // CSV Import file input
  const importCSVInput = document.getElementById("import-csv-input");

  if (importCSVInput) {
    importCSVInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (file) {
        if (!file.name.toLowerCase().endsWith('.csv')) {
          await showAlert("檔案格式錯誤", "請選擇 .csv 格式的檔案");
          return;
        }
        importHighlightedDoramasFromCSV(file);
      }
      // Reset the input so the same file can be selected again
      event.target.value = '';
    });
  }
  
    // Event listener for the parse file button
    const parseFileInput = document.getElementById("parse-file-input");
    if (parseFileInput) {
        parseFileInput.addEventListener("change", async (event) => {
            const file = event.target.files[0];
            if (file) {
                handleFileParse(file);
            }
            event.target.value = ''; // Reset input
        });
    }

  const shareButton = document.getElementById("share-button");
  const shareStatus = document.getElementById("share-status");
  const modal = document.getElementById("image-preview-modal");
  const modalCloseBtn = document.getElementById("modal-close-btn");
  const modalImageContainer = document.getElementById("modal-image-container");
  const modalCopyBtn = document.getElementById("modal-copy-btn");
  const modalDownloadBtn = document.getElementById("modal-download-btn");

  if (shareButton && shareStatus && modal) {
    shareButton.addEventListener("click", () => {
      shareStatus.textContent = "正在產生圖片...";
      shareButton.disabled = true;

      let imageContainer;
      let downloadFilename;
      const highlightedIds = new Set(
        JSON.parse(localStorage.getItem("highlightedDoramaIds")) || [],
      );

      if (
        currentDataSourceFile === "dorama_info.txtpb" &&
        highlightedIds.size > 0
      ) {
        // Generate image for highlighted doramas from main dataset
        const highlightedDoramas = allDoramas.filter((dorama) =>
          highlightedIds.has(String(dorama.doramaInfoId)),
        );
        downloadFilename = `my_watched_doramas_${highlightedDoramas.length}.png`;
        imageContainer = generateTop5PerYearChecklistImage(
          highlightedDoramas,
          highlightedIds,
          `日劇觀看清單 (${highlightedDoramas.length} 部)`,
        );
      } else if (currentDataSourceFile !== "dorama_info.txtpb") {
        const dataSourceConfig = {
          "top_100_dorama_info.txtpb": {
            title: "日劇 Top 100 觀看清單",
            filename: "top_100_dorama_checklist.png",
            type: "grid",
            columns: 10,
          },
          "top_5_lt_2000_dorama_info.txtpb": {
            title: "日劇每年 Top 5 觀看清單 (2000年前)",
            filename: "top_5_lt_2000_dorama_checklist.png",
            type: "yearRows",
          },
          "top_5_ge_2000_dorama_info.txtpb": {
            title: "日劇每年 Top 5 觀看清單 (2000年起)",
            filename: "top_5_ge_2000_dorama_checklist.png",
            type: "yearRows",
          },
        };

        const config = dataSourceConfig[currentDataSourceFile];
        if (config) {
          downloadFilename = config.filename;

          // Calculate highlighted count for progress display
          const highlightedCount = allDoramas.filter((dorama) =>
            highlightedIds.has(String(dorama.doramaInfoId)),
          ).length;
          const totalCount = allDoramas.length;
          const titleWithProgress = `${config.title} (${highlightedCount}/${totalCount})`;

          if (config.type === "yearRows") {
            imageContainer = generateTop5PerYearChecklistImage(
              allDoramas,
              highlightedIds,
              titleWithProgress,
            );
          } else {
            // Don't show checkmarks for any dataset
            imageContainer = generateDataSourceChecklistImage(
              allDoramas,
              highlightedIds,
              titleWithProgress,
              config.columns,
              false,
            );
          }
        } else {
          shareButton.disabled = false;
          return;
        }
      } else {
        shareButton.disabled = false;
        return;
      }

      document.body.appendChild(imageContainer);
      html2canvas(imageContainer, { scale: 2 })
        .then((canvas) => {
          document.body.removeChild(imageContainer);
          modalImageContainer.innerHTML = "";
          const img = document.createElement("img");
          img.src = canvas.toDataURL("image/png");
          modalImageContainer.appendChild(img);
          modal.style.display = "flex";
          document.body.classList.add("modal-open");
          shareStatus.textContent = "";
          updateShareButtonState();

          modalDownloadBtn.onclick = () => {
            const link = document.createElement("a");
            link.download = downloadFilename;
            link.href = canvas.toDataURL("image/png");
            link.click();
          };

          modalCopyBtn.onclick = () => {
            canvas.toBlob((blob) => {
              if (!blob) {
                alert("圖片轉換失敗!");
                return;
              }
              if (navigator.clipboard && navigator.clipboard.write) {
                const item = new ClipboardItem({ "image/png": blob });
                navigator.clipboard.write([item]).then(
                  () => alert("圖片已複製到剪貼簿！"),
                  (err) => {
                    console.error("複製失敗:", err);
                    alert("複製失敗，您的瀏覽器可能不支援此功能。");
                  },
                );
              } else {
                alert("您的瀏覽器不支援剪貼簿功能。");
              }
            }, "image/png");
          };
        })
        .catch((err) => {
          console.error("Image generation failed:", err);
          shareStatus.textContent = "建立圖片時發生錯誤";
          document.body.removeChild(imageContainer);
          updateShareButtonState();
        });
    });
  }

  if (modal && modalCloseBtn) {
    const closeModal = () => {
      modal.style.display = "none";
      modalImageContainer.innerHTML = "";
      document.body.classList.remove("modal-open");
    };
    modalCloseBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }
}

// --- Main Application Logic ---
async function loadDoramaInfo(dataSourceFile) {
  const statusDiv = document.getElementById("status-message");
  const gridContainer = document.getElementById("dorama-grid");
  statusDiv.textContent = `載入資料中...`;
  gridContainer.innerHTML = "<p>請稍候...</p>";
  try {
    const protoResponse = await fetch("dorama_info.proto");
    if (!protoResponse.ok) throw new Error(`無法載入 dorama_info.proto`);
    const protoContent = await protoResponse.text();
    const root = protobuf.parse(protoContent).root;
    const DoramaInfoMessage = root.lookupType("dorama.DoramaInfo");
    const textprotoResponse = await fetch(dataSourceFile);
    if (!textprotoResponse.ok) throw new Error(`無法載入 ${dataSourceFile}`);
    const textprotoContent = await textprotoResponse.text();
    if (!textprotoContent || textprotoContent.trim() === "") {
      throw new Error(`檔案 '${dataSourceFile}' 為空或無效`);
    }

    const plainJsObject = parseTextprotoToJsObject(textprotoContent);

    const camelCaseObject = convertKeysToCamelCase(plainJsObject);
    const doramaInfoInstance = DoramaInfoMessage.fromObject(camelCaseObject);
    if (!doramaInfoInstance) {
      throw new Error("無法從物件建立 Protobuf 訊息");
    }
    allDoramas = doramaInfoInstance.doramas || [];
    populateYearDropdowns();
    applyAllFilters();
    updateShareButtonState();
  } catch (error) {
    console.error("載入日劇資訊時發生錯誤:", error);
    statusDiv.textContent = `錯誤: ${error.message}`;
    gridContainer.innerHTML = `<p style="color: red;">無法載入日劇資料，請檢查主控台以獲取更多資訊。</p>`;
  }
}

// --- Main entry point ---
document.addEventListener("DOMContentLoaded", () => {
  // Setup responsive header and UI components
  setupResponsiveHeader();
  initializeActorToggle();

  // Setup all event listeners (only once)
  setupEventListeners();

  // Handle shared highlight URLs
  if (location.hash.startsWith("#share=")) {
    const idString = location.hash.substring(7);
    const ids = idString.split(",");
    localStorage.setItem("highlightedDoramaIds", JSON.stringify(ids));
    history.replaceState(null, "", " ");
    // Update display to show restored highlight count
    setTimeout(() => updateActiveFilterDisplay(), 100);
  }

  // Restore saved actor filter
  const savedActor = localStorage.getItem("activeActorFilter");
  if (savedActor) {
    activeActorFilter = savedActor;
  }

  // Determine which data source to load
  const savedDataSource = localStorage.getItem("selectedDataSource");
  const legacyShowTop100 = localStorage.getItem("showTop100");

  if (savedDataSource) {
    currentDataSourceFile = savedDataSource;
  } else if (legacyShowTop100 === "true") {
    currentDataSourceFile = "top_100_dorama_info.txtpb";
    localStorage.setItem("selectedDataSource", currentDataSourceFile);
    localStorage.removeItem("showTop100");
  } else {
    currentDataSourceFile = "dorama_info.txtpb";
  }

  // Initialize dropdown after determining data source
  initializeDataSourceDropdown();

  // Load the dorama data
  loadDoramaInfo(currentDataSourceFile);
});