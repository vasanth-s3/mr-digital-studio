(function ($) {
  "use strict";

  var reviewsUrl = "data/google-reviews.json";
  var $carousel = $("#google-reviews");
  var $status = $("#reviews-status");

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character];
    });
  }

  function dateLabel(value) {
    if (!value) return "Google review";
    var date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Google review"
      : date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  }

  function renderReview(review, businessName) {
    var rating = Math.max(0, Math.min(5, Math.round(review.rating || 0)));
    var stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    var author = escapeHtml(review.author || "Google user");
    var authorHtml = review.authorUrl
      ? '<a class="review-link" href="' + escapeHtml(review.authorUrl) + '" target="_blank" rel="noopener noreferrer">' + author + "</a>"
      : author;
    var reviewText = review.text
      ? "<p>“" + escapeHtml(review.text) + "”</p>"
      : "<p>Rated " + rating + " out of 5 stars.</p>";

    return (
      '<div class="item"><article class="item-box">' +
      '<span class="quote"><img src="img/quot.png" alt=""></span>' +
      '<div class="review-stars" aria-label="' + rating + ' out of 5 stars">' + stars + "</div>" +
      reviewText +
      '<div class="info"><div class="cont"><h6>' + authorHtml + "</h6>" +
      '<span>' + escapeHtml(businessName) + ' · <span class="review-date">' + escapeHtml(dateLabel(review.publishTime)) + "</span></span>" +
      "</div></div></article></div>"
    );
  }

  function showFallback() {
    $carousel.html(
      '<div class="item-box"><span class="quote"><img src="img/quot.png" alt=""></span>' +
      "<p>See what our clients are saying on Google.</p>" +
      '<div class="info"><div class="cont"><h6>MR Digital Studio</h6><span>Google Reviews</span></div></div></div>',
    );
    $status.text("Live reviews are temporarily unavailable. Visit Google to see the latest.");
    $carousel.owlCarousel({ items: 1, dots: false, loop: false, autoplay: false });
  }

  function showCachedReviews(data) {
    var reviews = Array.isArray(data.reviews) ? data.reviews : [];
    if (!reviews.length) {
      showFallback();
      return;
    }

    $carousel.html(reviews.map(function (review) {
      return renderReview(review, data.businessName || "MR Digital Studio");
    }).join(""));

    var ratingText = data.rating ? Number(data.rating).toFixed(1) + "/5" : "";
    var countText = data.reviewCount ? " from " + data.reviewCount + " reviews" : "";
    $status.html(
      '<span>' + escapeHtml(data.businessName || "MR Digital Studio") + (ratingText ? " · " + escapeHtml(ratingText) : "") + '</span> ' +
      (ratingText ? '<span class="reviews-summary-stars" aria-label="Rated ' + escapeHtml(data.rating || 0) + ' out of 5 stars"><span class="reviews-summary-full">★</span><span class="reviews-summary-full">★</span><span class="reviews-summary-full">★</span><span class="reviews-summary-full">★</span><span class="reviews-half-star">★</span></span> ' : "") +
      '<span>' + escapeHtml(countText + " on Google.") + "</span>",
    );
    $carousel.data("overall-rating", data.rating || 4.9);
    $carousel.data("overall-review-count", data.reviewCount || 131);

    $carousel.on("initialized.owl.carousel refreshed.owl.carousel", function (event) {
      var $dots = $(event.target).find(".owl-dots .owl-dot");
      var activeIndex = $(event.target).find(".owl-item.active").first().index();
      var activeDot = activeIndex >= 0 ? activeIndex % $dots.length : 0;
      var start = Math.max(0, Math.min(activeDot - 2, $dots.length - 5));
      $dots.each(function (index) {
        $(this).toggle($dots.length <= 5 || (index >= start && index < start + 5));
      });
      if ($dots.length > 5) {
        $dots.removeClass("is-current-window");
        $dots.slice(start, start + 5).addClass("is-current-window");
      }
    });

    $carousel.owlCarousel({
      loop: reviews.length > 1,
      margin: 15,
      mouseDrag: true,
      autoplay: true,
      autoplayTimeout: 4000,
      dots: true,
      smartSpeed: 1500,
      responsive: {
        0: { items: 1, dots: false },
        700: { items: 1, dots: true },
        1000: { items: 3, dots: true },
      },
    });

    if (data.googleMapsUri) {
        $("#reviews .reviews-footer a").attr("href", data.googleMapsUri);
    }
  }

  $.getJSON(reviewsUrl)
    .done(showCachedReviews)
    .fail(function () {
      $.getJSON("/data/google-reviews.json")
        .done(showCachedReviews)
        .fail(showFallback);
    });
})(jQuery);
