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
let allDoramas = [];
let currentDataSourceFile = "";
let activeActorFilter = "";
let searchTerm = "";
let displayedCountPerYear = {}; // Track how many doramas are displayed per year

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

  let contentHtml = `<h2 style="text-align: center; color: #333; font-size: 48px; font-weight: 700; margin: 0 0 30px 0;">${title}</h2>`;

  contentHtml += `<table style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px;">`;

  sortedYears.forEach((year) => {
    const yearDoramas = groupedByYear[year];
    contentHtml += `<tr style="height: 80px;">`;

    // Year header as first cell in the row (fixed width)
    const yearCellStyle = `width: 120px; padding: 10px 8px; font-size: 20px; font-weight: 700; border-radius: 5px; text-align: center; vertical-align: middle; background-color: #64748b; color: white; border: 1px solid #475569;`;
    contentHtml += `<td style="${yearCellStyle}">${year}</td>`;

    // Doramas in the same row (equal width columns)
    const doramaColumnWidth = (100 - 12) / 5; // 12% for year column, remaining divided by 5
    yearDoramas.forEach((dorama) => {
      const isSeen = highlightedIds.has(String(dorama.doramaInfoId));
      const seenStyle = `background-color: #10b981; color: white; border: 1px solid #059669; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);`;
      const unseenStyle = `background-color: #f8fafc; color: #475569; border: 1px solid #e2e8f0;`;
      const cellStyle = `width: ${doramaColumnWidth}%; padding: 10px 8px; font-size: 17px; font-weight: 600; border-radius: 5px; text-align: center; vertical-align: middle; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; ${isSeen ? seenStyle : unseenStyle}`;
      contentHtml += `<td style="${cellStyle}">${dorama.chineseTitle}</td>`;
    });

    // Fill empty cells if less than 5 doramas
    for (let i = yearDoramas.length; i < 5; i++) {
      contentHtml += `<td style="width: ${doramaColumnWidth}%;"></td>`;
    }

    contentHtml += `</tr>`;
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
  if (!shareButton) return;

  const isSpecialDataSource = currentDataSourceFile !== "dorama_info.txtpb";
  const highlightedIds = JSON.parse(
    localStorage.getItem("highlightedDoramaIds") || "[]",
  );
  const hasHighlightedDoramas = highlightedIds.length > 0;

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
        header.classList.remove("filters-open");
        if (menuToggleBtn) menuToggleBtn.setAttribute("aria-expanded", "false");
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
        imageContainer = generateDataSourceChecklistImage(
          highlightedDoramas,
          highlightedIds,
          `日劇觀看清單 (${highlightedDoramas.length} 部)`,
          8, // Use 8 columns for a good layout
          false, // Don't show checkmarks
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

    // FIX: Changed variable from the incorrect 'textprotoString' to the correct 'textprotoContent'
    const plainJsObject = parseTextprotoToJsObject(textprotoContent);

    const camelCaseObject = convertKeysToCamelCase(plainJsObject);
    const doramaInfoInstance = DoramaInfoMessage.fromObject(camelCaseObject);
    if (!doramaInfoInstance) {
      throw new Error("無法從物件建立 Protobuf 訊息");
    }
    allDoramas = doramaInfoInstance.doramas || [];
    populateYearDropdowns();
    applyAllFilters();
    setupEventListeners();
    initializeActorToggle();
    initializeDataSourceDropdown();
    updateShareButtonState();
  } catch (error) {
    console.error("載入日劇資訊時發生錯誤:", error);
    statusDiv.textContent = `錯誤: ${error.message}`;
    gridContainer.innerHTML = `<p style="color: red;">無法載入日劇資料，請檢查主控台以獲取更多資訊。</p>`;
  }
}

// --- Main entry point ---
document.addEventListener("DOMContentLoaded", () => {
  setupResponsiveHeader();
  initializeDataSourceDropdown();
  initializeActorToggle();
  setupEventListeners();
  if (location.hash.startsWith("#share=")) {
    const idString = location.hash.substring(7);
    const ids = idString.split(",");
    localStorage.setItem("highlightedDoramaIds", JSON.stringify(ids));
    history.replaceState(null, "", " ");
  }

  const savedActor = localStorage.getItem("activeActorFilter");
  if (savedActor) {
    activeActorFilter = savedActor;
  }

  // Handle legacy localStorage key for backwards compatibility
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

  loadDoramaInfo(currentDataSourceFile);
});
