const startBtn = document.querySelector("#welcome-start-btn");

startBtn?.addEventListener("click", () => {
  window.location.href = "/index.html?autostartSession=1";
});
