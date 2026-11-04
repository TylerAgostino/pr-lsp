use zed_extension_api as zed;

struct PrReview;

impl zed::Extension for PrReview {
    fn new() -> Self {
        Self
    }
}

zed::register_extension!(PrReview);
