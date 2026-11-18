mod bridge;
mod can_admin;
mod cli;
mod encoder;
mod engine;
mod experiment;
mod firmware;
mod fit;
mod hardware;
mod manual;
mod paths;
mod pipeline;
mod protocol;
mod registers;
mod stationary;
mod types;

fn main() -> anyhow::Result<()> {
    cli::dispatch()
}
